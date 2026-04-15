"""
ingest.py — Ingestion pipeline using Jina CLIP v2 + Gemma image captioning.

POST   /ingest/file    { file_path, file_name, user_id }
DELETE /ingest/file    { file_name, user_id }
PATCH  /ingest/move    { old_name, new_name, user_id }  ← update metadata only, no re-embed
GET    /ingest/indexed?user_id=...
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
CAPTION_MODEL = "google/gemma-3-12b-it"

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


# ── Image captioning ───────────────────────────────────────────────────────────


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
    if not OPENROUTER_API_KEY:
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
                            {"type": "image_url", "image_url": {"url": b64}},
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
    inputs = [{"text": chunk["text"]} for chunk in chunks]
    headers = {
        "Authorization": f"Bearer {JINA_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {"model": JINA_CLIP_MODEL, "input": inputs, "normalized": True}

    delay = RETRY_BASE_DELAY
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(
                JINA_CLIP_URL, headers=headers, json=payload, timeout=60
            )
            if resp.status_code == 429:
                wait = max(int(resp.headers.get("Retry-After", delay)), delay)
                print(
                    f"[ingest] Rate limited, waiting {wait:.1f}s (attempt {attempt}/{MAX_RETRIES})"
                )
                time.sleep(wait)
                delay *= 2
                continue
            resp.raise_for_status()
            ordered = sorted(resp.json()["data"], key=lambda x: x["index"])
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
        print(f"[ingest] {file_name}: batch {i // JINA_BATCH_SIZE + 1}/{total_batches}")
        batch_embs = _embed_batch_with_retry(chunks[i : i + JINA_BATCH_SIZE])
        all_embeddings.extend(batch_embs)
        if i + JINA_BATCH_SIZE < len(chunks):
            time.sleep(0.5)
    return all_embeddings


def _prepare_chunks(
    chunks: List[Dict[str, Any]], file_name: str
) -> List[Dict[str, Any]]:
    prepared = []
    for chunk in chunks:
        if chunk.get("modality") == "image" and chunk.get("file_path"):
            caption = _caption_image(chunk["file_path"], file_name)
            prepared.append({**chunk, "text": caption})
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


class MoveRequest(BaseModel):
    old_name: str  # previous file_name stored in metadata
    new_name: str  # new file_name (after rename or folder move)
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


@router.patch("/move")
def move_file_embeddings(req: MoveRequest):
    """
    Update ChromaDB metadata when a file is renamed or moved to a different folder.
    Reuses existing embeddings — no re-ingestion needed.
    """
    try:
        collection = _get_collection(req.user_id)

        # Get all chunks for the old file name
        results = collection.get(
            where={"file_name": req.old_name},
            include=["embeddings", "documents", "metadatas"],
        )

        if not results["ids"]:
            print(f"[ingest] move: no chunks found for {req.old_name}")
            return {"status": "skipped", "detail": "no chunks found for old name"}

        old_ids = results["ids"]
        old_embeddings = results["embeddings"]
        old_documents = results["documents"]
        old_metadatas = results["metadatas"]

        # Build new IDs and updated metadatas
        # New chunk IDs are based on new_name so they don't collide
        new_ids = []
        new_metadatas = []
        for i, meta in enumerate(old_metadatas):
            chunk_index = meta.get("chunk_index", i)
            new_ids.append(_chunk_id(req.new_name, chunk_index))
            new_metadatas.append(
                {
                    **meta,
                    "file_name": req.new_name,
                }
            )

        # Delete old chunks
        collection.delete(ids=old_ids)

        # Insert under new IDs with updated metadata, same embeddings
        for i in range(0, len(new_ids), CHROMA_BATCH_SIZE):
            collection.upsert(
                ids=new_ids[i : i + CHROMA_BATCH_SIZE],
                embeddings=old_embeddings[i : i + CHROMA_BATCH_SIZE],
                documents=old_documents[i : i + CHROMA_BATCH_SIZE],
                metadatas=new_metadatas[i : i + CHROMA_BATCH_SIZE],
            )

        print(
            f"[ingest] ✅ Moved embeddings: {req.old_name} → {req.new_name} ({len(new_ids)} chunks)"
        )
        return {"status": "ok", "chunks": len(new_ids)}

    except Exception as e:
        print(f"[ingest] Error moving embeddings {req.old_name} → {req.new_name}: {e}")
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
