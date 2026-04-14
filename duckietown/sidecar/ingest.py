"""
ingest.py — Ingestion pipeline using Jina CLIP v2 + Gemma image captioning.

POST   /ingest/file    { file_path, file_name, user_id }
DELETE /ingest/file    { file_name, user_id }
GET    /ingest/indexed?user_id=...  → { files: [name, ...] }

Pipeline for images:
  1. Send image to Gemma 3 (OpenRouter) → get rich text description
  2. Embed that description via Jina text encoder
  This means "show me images with 2 people" actually works.

Pipeline for text files:
  1. Extract text chunks via extract.py
  2. Embed via Jina text encoder
"""

import base64
import hashlib
import os
import ssl
import time

import requests

ssl._create_default_https_context = ssl._create_unverified_context
os.environ["ANONYMIZED_TELEMETRY"] = "False"
os.environ["CHROMA_TELEMETRY"] = "False"

from pathlib import Path
from typing import Any, Dict, List, Optional

import chromadb
from extract import extract
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# ── Config ─────────────────────────────────────────────────────────────────────

JINA_API_KEY = os.environ.get("JINA_API_KEY", "")
JINA_CLIP_URL = "https://api.jina.ai/v1/embeddings"
JINA_CLIP_MODEL = "jina-clip-v2"

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
CAPTION_MODEL = "google/gemma-3-12b-it"  # fast, vision-capable, cheap

JINA_BATCH_SIZE = 8
CHROMA_BATCH_SIZE = 100
MAX_RETRIES = 5
RETRY_BASE_DELAY = 2.0

# ── ChromaDB ───────────────────────────────────────────────────────────────────

CHROMA_DIR = os.environ.get(
    "CHROMA_DIR",
    str(Path.home() / ".duckietown" / "chromadb"),
)
Path(CHROMA_DIR).mkdir(parents=True, exist_ok=True)
_chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)


def _get_collection(user_id: str) -> chromadb.Collection:
    safe_id = "user_" + user_id.replace("-", "_")
    return _chroma_client.get_or_create_collection(
        name=safe_id,
        metadata={"hnsw:space": "cosine"},
    )


# ── Image captioning via Gemma ─────────────────────────────────────────────────


def _image_to_base64(file_path: str) -> Optional[str]:
    try:
        import mimetypes

        mime, _ = mimetypes.guess_type(file_path)
        mime = mime or "image/jpeg"
        with open(file_path, "rb") as f:
            data = base64.b64encode(f.read()).decode("utf-8")
        return f"data:{mime};base64,{data}"
    except Exception as e:
        print(f"[ingest] Image base64 error: {e}")
        return None


def _caption_image(file_path: str, file_name: str) -> str:
    """
    Send image to Gemma 3 via OpenRouter and get a rich text description.
    Falls back to filename if captioning fails.
    """
    if not OPENROUTER_API_KEY:
        print("[ingest] No OPENROUTER_API_KEY, skipping caption")
        return f"Image: {Path(file_path).stem}"

    b64 = _image_to_base64(file_path)
    if not b64:
        return f"Image: {Path(file_path).stem}"

    try:
        resp = requests.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "HTTP-Referer": "https://duckietown.app",
                "Content-Type": "application/json",
            },
            json={
                "model": CAPTION_MODEL,
                "max_tokens": 300,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": b64},
                            },
                            {
                                "type": "text",
                                "text": (
                                    "Describe this image in detail for search indexing. "
                                    "Include: number of people and their appearance, objects, "
                                    "setting/location, colors, actions, text visible, mood. "
                                    "Be specific and thorough. Reply with description only, no preamble."
                                ),
                            },
                        ],
                    }
                ],
            },
            timeout=30,
        )
        resp.raise_for_status()
        caption = resp.json()["choices"][0]["message"]["content"].strip()
        print(f"[ingest] Caption for {file_name}: {caption[:100]}...")
        return caption
    except Exception as e:
        print(f"[ingest] Caption failed for {file_name}: {e}")
        return f"Image: {Path(file_path).stem}"


# ── Jina embedding ─────────────────────────────────────────────────────────────


def _embed_batch_with_retry(chunks: List[Dict[str, Any]]) -> List[List[float]]:
    """Embed a batch via Jina text encoder with exponential backoff on 429."""
    # All chunks at this point have a 'text' field (images were captioned already)
    inputs = [{"text": chunk["text"]} for chunk in chunks]

    headers = {
        "Authorization": f"Bearer {JINA_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": JINA_CLIP_MODEL,
        "input": inputs,
        "normalized": True,
    }

    delay = RETRY_BASE_DELAY
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(
                JINA_CLIP_URL, headers=headers, json=payload, timeout=60
            )
            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", delay))
                wait = max(retry_after, delay)
                print(
                    f"[ingest] Rate limited, waiting {wait:.1f}s (attempt {attempt}/{MAX_RETRIES})"
                )
                time.sleep(wait)
                delay *= 2
                continue
            resp.raise_for_status()
            data = resp.json()
            ordered = sorted(data["data"], key=lambda x: x["index"])
            return [item["embedding"] for item in ordered]
        except requests.exceptions.HTTPError as e:
            if attempt == MAX_RETRIES:
                raise
            print(f"[ingest] HTTP error {e}, retrying in {delay}s...")
            time.sleep(delay)
            delay *= 2

    raise RuntimeError(f"Failed after {MAX_RETRIES} retries")


def _embed_chunks(chunks: List[Dict[str, Any]], file_name: str) -> List[List[float]]:
    all_embeddings = []
    total_batches = -(-len(chunks) // JINA_BATCH_SIZE)
    for i in range(0, len(chunks), JINA_BATCH_SIZE):
        batch_num = i // JINA_BATCH_SIZE + 1
        print(f"[ingest] {file_name}: batch {batch_num}/{total_batches}")
        batch = chunks[i : i + JINA_BATCH_SIZE]
        batch_embs = _embed_batch_with_retry(batch)
        all_embeddings.extend(batch_embs)
        if i + JINA_BATCH_SIZE < len(chunks):
            time.sleep(0.5)
    return all_embeddings


# ── Chunk prep — caption images before embedding ───────────────────────────────


def _prepare_chunks(
    chunks: List[Dict[str, Any]], file_name: str
) -> List[Dict[str, Any]]:
    """
    For image chunks: replace the stub text with a real Gemma caption.
    For all other chunks: pass through unchanged.
    """
    prepared = []
    for chunk in chunks:
        if chunk.get("modality") == "image" and chunk.get("file_path"):
            caption = _caption_image(chunk["file_path"], file_name)
            prepared.append(
                {
                    **chunk,
                    "text": caption,  # replace "Image: filename" with real description
                }
            )
        else:
            prepared.append(chunk)
    return prepared


# ── Chunk ID ───────────────────────────────────────────────────────────────────


def _chunk_id(file_name: str, chunk_index: int) -> str:
    return hashlib.md5(f"{file_name}::{chunk_index}".encode()).hexdigest()


# ── API models ─────────────────────────────────────────────────────────────────


class IngestRequest(BaseModel):
    file_path: str
    file_name: str
    user_id: str


class DeleteRequest(BaseModel):
    file_name: str
    user_id: str


# ── Endpoints ──────────────────────────────────────────────────────────────────


@router.get("/indexed")
def get_indexed_files(user_id: str):
    try:
        collection = _get_collection(user_id)
        if collection.count() == 0:
            return {"files": []}
        results = collection.get(include=["metadatas"])
        names = list({m["file_name"] for m in results["metadatas"]})
        return {"files": names}
    except Exception as e:
        print(f"[ingest] Error listing indexed files: {e}")
        return {"files": []}


@router.post("/file")
def ingest_file(req: IngestRequest):
    if not os.path.exists(req.file_path):
        return {"status": "error", "detail": "file not found"}
    if not JINA_API_KEY:
        return {"status": "error", "detail": "JINA_API_KEY not configured"}

    try:
        chunks = extract(req.file_path)
        if not chunks:
            return {"status": "skipped", "detail": "no extractable content"}

        # Caption images before embedding
        chunks = _prepare_chunks(chunks, req.file_name)

        print(f"[ingest] {req.file_name}: {len(chunks)} chunks, embedding with Jina...")
        embeddings = _embed_chunks(chunks, req.file_name)

        collection = _get_collection(req.user_id)
        ids = [_chunk_id(req.file_name, c["chunk_index"]) for c in chunks]
        docs = [c["text"] for c in chunks]
        metadatas = [
            {
                "file_name": req.file_name,
                "chunk_index": c["chunk_index"],
                "modality": c.get("modality", "text"),
                "page": str(c.get("page") or ""),
            }
            for c in chunks
        ]

        for i in range(0, len(ids), CHROMA_BATCH_SIZE):
            collection.upsert(
                ids=ids[i : i + CHROMA_BATCH_SIZE],
                embeddings=embeddings[i : i + CHROMA_BATCH_SIZE],
                documents=docs[i : i + CHROMA_BATCH_SIZE],
                metadatas=metadatas[i : i + CHROMA_BATCH_SIZE],
            )

        print(f"[ingest] ✅ {req.file_name}: {len(chunks)} chunks stored")
        return {"status": "ok", "chunks": len(chunks), "file": req.file_name}

    except Exception as e:
        print(f"[ingest] Error ingesting {req.file_name}: {e}")
        return {"status": "error", "detail": str(e)}


@router.delete("/file")
def delete_file(req: DeleteRequest):
    try:
        collection = _get_collection(req.user_id)
        results = collection.get(where={"file_name": req.file_name})
        if results["ids"]:
            collection.delete(ids=results["ids"])
        return {"status": "ok", "deleted": len(results["ids"])}
    except Exception as e:
        print(f"[ingest] Error deleting {req.file_name}: {e}")
        return {"status": "error", "detail": str(e)}
