"""
search.py — Semantic search + smart RAG chat + organise intent parsing.

POST /search/query          { query, user_id, top_k? }
POST /search/chat           { message, user_id, history?, file_name? }
POST /search/organise-intent { message, user_id }
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
    CAPTION_MODEL,
    JINA_API_KEY,
    JINA_CLIP_MODEL,
    JINA_CLIP_URL,
    OPENROUTER_API_KEY,
    OPENROUTER_URL,
    _get_collection,
)
from pydantic import BaseModel

router = APIRouter()

CHAT_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-3-27b-it")

SIMILARITY_THRESHOLD = 0.7
TOP_K_DEFAULT = 50
TOP_FALLBACK = 3

# ── Type keyword detection ─────────────────────────────────────────────────────

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
    "gif": "image",
    "screenshot": "image",
    "screenshots": "image",
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
    "text": "text",
    "audio": "audio",
    "music": "audio",
    "video": "video",
    "videos": "video",
}


def _detect_type_filter(query: str) -> Optional[str]:
    words = re.findall(r"\w+", query.lower())
    for word in words:
        if word in TYPE_KEYWORDS:
            return TYPE_KEYWORDS[word]
    return None


# ── Filename detection ─────────────────────────────────────────────────────────


def _extract_mentioned_filenames(message: str, collection) -> List[str]:
    """
    Check if the message explicitly mentions any filename that exists in ChromaDB.
    Returns list of matching file names.
    """
    try:
        # Get all unique file names from the collection
        results = collection.get(include=["metadatas"])
        all_files = list({m["file_name"] for m in results["metadatas"]})
    except Exception:
        return []

    mentioned = []
    message_lower = message.lower()
    for fname in all_files:
        # Check if filename (with or without extension) appears in message
        name_lower = fname.lower()
        stem = name_lower.rsplit(".", 1)[0]  # filename without extension
        if name_lower in message_lower or stem in message_lower:
            mentioned.append(fname)
    return mentioned


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


# ── Context retrieval (shared by chat and query) ───────────────────────────────


def _retrieve_context(
    message: str, user_id: str, file_name: Optional[str] = None, top_k: int = 8
):
    """
    Smart retrieval:
    1. If file_name is set, fetch all chunks for that file directly.
    2. Check if message mentions any known filenames → fetch those chunks directly.
    3. Semantic search for remaining slots.
    Merges and deduplicates results.
    Returns (context_text, source_files_list)
    """
    collection = _get_collection(user_id)
    count = collection.count()
    if count == 0:
        return "", []

    context_parts = []
    seen_files = {}  # file_name → best similarity

    # ── Step 1: Explicitly named file ─────────────────────────────────────────
    target_files = []
    if file_name:
        target_files.append(file_name)

    # ── Step 2: Detect filenames mentioned in the message ─────────────────────
    mentioned = _extract_mentioned_filenames(message, collection)
    for f in mentioned:
        if f not in target_files:
            target_files.append(f)

    for tf in target_files:
        try:
            file_chunks = collection.get(
                where={"file_name": tf},
                include=["documents", "metadatas"],
            )
            if file_chunks["documents"]:
                # Take up to 20 chunks per file to avoid context overflow
                chunks = file_chunks["documents"][:20]
                metas = file_chunks["metadatas"][:20]
                for doc, meta in zip(chunks, metas):
                    page = f" (page {meta['page']})" if meta.get("page") else ""
                    context_parts.append(f"[{tf}{page}]\n{doc}")
                seen_files[tf] = 1.0  # direct match = 100%
        except Exception as e:
            print(f"[search] Error fetching chunks for {tf}: {e}")

    # ── Step 3: Semantic search to fill remaining context ─────────────────────
    try:
        query_emb = _embed_query(message)
        n = min(top_k, count)
        results = collection.query(
            query_embeddings=[query_emb],
            n_results=n,
            include=["documents", "metadatas", "distances"],
        )
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            sim = max(0.0, 1.0 - dist / 2.0)
            fname = meta["file_name"]
            if fname in seen_files:
                continue  # already included via direct fetch
            if sim < 0.3:
                continue
            page = f" (page {meta['page']})" if meta.get("page") else ""
            context_parts.append(f"[{fname}{page}, relevance: {sim:.2f}]\n{doc}")
            if fname not in seen_files or sim > seen_files[fname]:
                seen_files[fname] = sim
    except Exception as e:
        print(f"[search] Semantic retrieval error: {e}")

    context_text = "\n\n---\n\n".join(context_parts)
    source_files = [
        {"file_name": f, "similarity": round(s, 4)}
        for f, s in sorted(seen_files.items(), key=lambda x: x[1], reverse=True)
    ]
    return context_text, source_files


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
    file_name: Optional[str] = None


class OrganiseIntentRequest(BaseModel):
    message: str
    user_id: str


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

        seen: dict = {}
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            similarity = max(0.0, 1.0 - dist / 2.0)
            name = meta["file_name"]
            modality = meta.get("modality", "text")

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
        above_threshold = [
            r for r in all_ranked if r["similarity"] >= SIMILARITY_THRESHOLD
        ]
        ranked = above_threshold if above_threshold else all_ranked[:TOP_FALLBACK]

        return {"results": ranked, "total_indexed": count, "type_filter": type_filter}

    except Exception as e:
        print(f"[search] Query error: {e}")
        return {"results": [], "error": str(e)}


# ── Chat endpoint ──────────────────────────────────────────────────────────────


@router.post("/chat")
async def chat(req: ChatRequest):
    if not OPENROUTER_API_KEY:
        return {"error": "OPENROUTER_API_KEY not set"}

    context_text, source_files = _retrieve_context(
        req.message, req.user_id, req.file_name, top_k=10
    )

    system_prompt = (
        "You are Duckietown AI, a helpful assistant for a personal file vault. "
        "You have access to the content of the user's files. "
        "Answer questions accurately based on the file content provided below. "
        "Always cite which file your answer comes from. "
        "If the file content is provided, use it — don't say you can't access files.\n\n"
    )
    if context_text:
        system_prompt += f"FILE CONTENT FROM THE VAULT:\n\n{context_text}"
    else:
        system_prompt += (
            "No relevant file content was found for this query. "
            "Tell the user which files you couldn't find and suggest they check if the files have been ingested."
        )

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
                    "max_tokens": 2048,
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


# ── Organise intent endpoint ───────────────────────────────────────────────────


@router.post("/organise-intent")
def parse_organise_intent(req: OrganiseIntentRequest):
    """
    Use Gemma to parse a natural language organise command into structured intent.
    Returns { is_organise: bool, query: str, folder_name: str, type_filter: str|null }

    Examples:
      "group all images into a folder called photos"
        → { is_organise: true, query: "images", folder_name: "photos", type_filter: "image" }
      "put all legal documents in legal"
        → { is_organise: true, query: "legal documents contracts", folder_name: "legal", type_filter: null }
      "what does the Q3 report say?"
        → { is_organise: false }
    """
    if not OPENROUTER_API_KEY:
        return {"is_organise": False, "error": "OPENROUTER_API_KEY not set"}

    system_prompt = """You are a file organisation assistant. Determine if the user's message is a request to organise/group/move files into folders.

If it IS an organise request, respond with ONLY this JSON:
{
  "is_organise": true,
  "query": "<semantic search query to find matching files>",
  "folder_name": "<name for the new folder>",
  "type_filter": "<one of: image, text, audio, video, or null>"
}

Rules for type_filter:
- "image" if user says: images, photos, pictures, screenshots, jpg, png, gif
- "text" if user says: documents, pdfs, word files, spreadsheets, csvs, excel, docs
- "audio" if user says: audio, music, sound files
- "video" if user says: videos, movies, clips
- null for everything else or mixed types

Rules for query:
- Make it a rich semantic search query that captures the intent
- For type-based: "image photo picture visual" or "pdf document text file"
- For content-based: use descriptive words about the content e.g. "legal contract agreement law"

If it is NOT an organise request, respond with ONLY:
{"is_organise": false}

Never include any explanation, only the JSON."""

    try:
        resp = requests.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "HTTP-Referer": "https://duckietown.app",
                "Content-Type": "application/json",
            },
            json={
                "model": CAPTION_MODEL,  # use faster 12B for intent parsing
                "max_tokens": 200,
                "temperature": 0.0,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": req.message},
                ],
            },
            timeout=20,
        )
        resp.raise_for_status()
        raw = resp.json()["choices"][0]["message"]["content"].strip()

        # Strip markdown code fences if present
        raw = re.sub(r"```(?:json)?", "", raw).strip().strip("`").strip()
        result = json.loads(raw)
        return result

    except Exception as e:
        print(f"[search] Organise intent parse error: {e}")
        return {"is_organise": False, "error": str(e)}
