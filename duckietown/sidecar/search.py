"""
search.py — Semantic search + RAG chat via Gemma.

POST /search/query  { query, user_id, top_k? }
    → files above 0.7 similarity, or top 3 if none qualify
    → type-aware: if query mentions images/pdfs/etc, filters to that type

POST /search/chat   { message, user_id, history?, file_name? }
    → streaming Gemma response grounded on file content
"""

import json
import os
import re
import ssl

import requests

ssl._create_default_https_context = ssl._create_unverified_context
os.environ["ANONYMIZED_TELEMETRY"] = "False"
os.environ["CHROMA_TELEMETRY"] = "False"

from typing import List, Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from ingest import (
    JINA_API_KEY,
    JINA_CLIP_MODEL,
    JINA_CLIP_URL,
    OPENROUTER_API_KEY,
    _get_collection,
)
from pydantic import BaseModel

router = APIRouter()

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
CHAT_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-3-27b-it")

SIMILARITY_THRESHOLD = 0.7
TOP_K_DEFAULT = 50
TOP_FALLBACK = 3  # return this many if nothing clears threshold

# ── Type keyword detection ─────────────────────────────────────────────────────

# Maps query keywords → modality values stored in ChromaDB metadata
TYPE_KEYWORDS = {
    "image": "image",
    "images": "image",
    "photo": "image",
    "photos": "image",
    "picture": "image",
    "pictures": "image",
    "jpg": "image",
    "jpeg": "image",
    "png": "image",
    "pdf": "text",
    "pdfs": "text",
    "document": "text",
    "documents": "text",
    "doc": "text",
    "docx": "text",
    "word": "text",
    "spreadsheet": "text",
    "excel": "text",
    "xlsx": "text",
    "csv": "text",
    "audio": "audio",
    "music": "audio",
    "video": "video",
    "videos": "video",
}

# Maps query keywords → mime_type prefix for frontend filtering hint
MIME_HINTS = {
    "image": "image/",
    "images": "image/",
    "photo": "image/",
    "photos": "image/",
    "picture": "image/",
    "pictures": "image/",
    "pdf": "application/pdf",
    "pdfs": "application/pdf",
    "audio": "audio/",
    "video": "video/",
}


def _detect_type_filter(query: str) -> Optional[str]:
    """Return a modality string if the query explicitly mentions a file type."""
    words = re.findall(r"\w+", query.lower())
    for word in words:
        if word in TYPE_KEYWORDS:
            return TYPE_KEYWORDS[word]
    return None


# ── Jina query embedding ───────────────────────────────────────────────────────


def _embed_query(text: str) -> List[float]:
    headers = {
        "Authorization": f"Bearer {JINA_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": JINA_CLIP_MODEL,
        "input": [{"text": text}],
        "normalized": True,
    }
    resp = requests.post(JINA_CLIP_URL, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


# ── API models ─────────────────────────────────────────────────────────────────


class QueryRequest(BaseModel):
    query: str
    user_id: str
    top_k: int = TOP_K_DEFAULT


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    user_id: str
    history: Optional[List[ChatMessage]] = []
    file_name: Optional[str] = None  # if set, ground on this specific file


# ── Search endpoint ────────────────────────────────────────────────────────────


@router.post("/query")
def semantic_query(req: QueryRequest):
    if not JINA_API_KEY:
        return {"results": [], "error": "JINA_API_KEY not configured"}

    try:
        collection = _get_collection(req.user_id)
        count = collection.count()
        if count == 0:
            return {"results": [], "total_indexed": 0}

        query_emb = _embed_query(req.query)
        n = min(req.top_k, count)
        type_filter = _detect_type_filter(req.query)

        results = collection.query(
            query_embeddings=[query_emb],
            n_results=n,
            include=["documents", "metadatas", "distances"],
        )

        # Deduplicate by file name, keep best score per file
        seen: dict = {}
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            similarity = max(0.0, 1.0 - dist / 2.0)
            name = meta["file_name"]
            modality = meta.get("modality", "text")

            # Apply type filter if query requested a specific type
            if type_filter and modality != type_filter:
                continue

            if name not in seen or similarity > seen[name]["similarity"]:
                seen[name] = {
                    "file_name": name,
                    "similarity": round(similarity, 4),
                    "snippet": doc[:200],
                    "modality": modality,
                    "page": meta.get("page", ""),
                }

        all_ranked = sorted(seen.values(), key=lambda x: x["similarity"], reverse=True)

        # Apply threshold: return files >= 0.7, fallback to top 3 if none qualify
        above_threshold = [
            r for r in all_ranked if r["similarity"] >= SIMILARITY_THRESHOLD
        ]
        if above_threshold:
            ranked = above_threshold
        else:
            ranked = all_ranked[:TOP_FALLBACK]

        return {"results": ranked, "total_indexed": count, "type_filter": type_filter}

    except Exception as e:
        print(f"[search] Query error: {e}")
        return {"results": [], "error": str(e)}


# ── Chat endpoint ──────────────────────────────────────────────────────────────


@router.post("/chat")
async def chat(req: ChatRequest):
    """
    RAG chat grounded on vault file content.
    If file_name is provided, retrieves chunks from that specific file.
    Otherwise retrieves top chunks matching the message.
    Streams back tokens via SSE.
    """
    if not OPENROUTER_API_KEY:
        return {"error": "OPENROUTER_API_KEY not set"}

    # Retrieve context
    context_text = ""
    source_files = []

    try:
        collection = _get_collection(req.user_id)
        count = collection.count()

        if count > 0:
            if req.file_name:
                # Get all chunks for this specific file
                file_chunks = collection.get(
                    where={"file_name": req.file_name},
                    include=["documents"],
                )
                if file_chunks["documents"]:
                    context_text = "\n\n".join(file_chunks["documents"][:20])
                    source_files = [{"file_name": req.file_name, "similarity": 1.0}]
            else:
                # Semantic retrieval for general questions
                query_emb = _embed_query(req.message)
                results = collection.query(
                    query_embeddings=[query_emb],
                    n_results=min(8, count),
                    include=["documents", "metadatas", "distances"],
                )
                chunks = []
                seen_files = set()
                for doc, meta, dist in zip(
                    results["documents"][0],
                    results["metadatas"][0],
                    results["distances"][0],
                ):
                    sim = max(0.0, 1.0 - dist / 2.0)
                    if sim > 0.3:
                        fname = meta["file_name"]
                        page = f" (page {meta['page']})" if meta.get("page") else ""
                        chunks.append(f"[{fname}{page}]\n{doc}")
                        if fname not in seen_files:
                            source_files.append(
                                {"file_name": fname, "similarity": round(sim, 4)}
                            )
                            seen_files.add(fname)
                context_text = "\n\n---\n\n".join(chunks)
    except Exception as e:
        print(f"[chat] Context retrieval error: {e}")

    # Build system prompt
    system_prompt = (
        "You are Duckietown AI, a helpful assistant for a personal file vault. "
        "Answer questions based on the file content provided. "
        "Be concise and clear. Always cite which file your answer comes from.\n\n"
    )
    if context_text:
        system_prompt += f"FILE CONTENT:\n{context_text}"
    else:
        system_prompt += "No relevant file content found for this query."

    messages = [{"role": "system", "content": system_prompt}]
    for h in req.history or []:
        messages.append({"role": h.role, "content": h.content})
    messages.append({"role": "user", "content": req.message})

    async def event_stream():
        yield f"data: {json.dumps({'type': 'sources', 'files': source_files})}\n\n"

        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream(
                "POST",
                OPENROUTER_URL,
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "HTTP-Referer": "https://duckietown.app",
                    "Content-Type": "application/json",
                },
                json={
                    "model": CHAT_MODEL,
                    "messages": messages,
                    "stream": True,
                    "max_tokens": 1024,
                    "temperature": 0.3,
                },
            ) as response:
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if raw == "[DONE]":
                        yield "data: [DONE]\n\n"
                        return
                    try:
                        chunk = json.loads(raw)
                        delta = chunk["choices"][0]["delta"].get("content", "")
                        if delta:
                            yield f"data: {json.dumps({'type': 'token', 'content': delta})}\n\n"
                    except Exception:
                        pass
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
