"""
ingest.py — Ingestion pipeline: extract → caption (images) → enrich (file
profile) → embed via Jina → upsert into ChromaDB.

POST   /ingest/file     { file_path, file_name, user_id, folder_path }
DELETE /ingest/file     { file_name, user_id }
PATCH  /ingest/move     { old_name, new_name, new_folder_path, user_id }  ← metadata only, no re-embed
GET    /ingest/indexed?user_id=...
GET    /ingest/profiles-missing?user_id=...
POST   /ingest/enrich   { file_path?, file_name, user_id }   ← backfill path
"""

import base64
import hashlib
import os
import ssl

ssl._create_default_https_context = ssl._create_unverified_context
os.environ["ANONYMIZED_TELEMETRY"] = "False"
os.environ["CHROMA_TELEMETRY"] = "False"

from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

import enrich
from chroma_store import get_collection
from config import CAPTION_MODEL, JINA_API_KEY
from extract import extract
from jina_client import embed_texts
from openrouter_client import OpenRouterError, vision_caption

router = APIRouter()

CHROMA_BATCH_SIZE = 100

# Only these extraction modalities get a profile — audio/video/other are
# filename-stub-only today (see docs/ARCHITECTURE.md) and have no real
# content to profile.
ENRICHABLE_MODALITIES = {"text", "image"}

_CAPTION_PROMPT = (
    "Describe this image in detail for search indexing. "
    "Include: number of people and their appearance, objects, "
    "setting/location, colors, actions, text visible, mood. "
    "Be specific and thorough. Reply with description only, no preamble."
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
    b64 = _image_to_base64(file_path)
    if not b64:
        return f"Image: {Path(file_path).stem}"
    try:
        return vision_caption(CAPTION_MODEL, b64, _CAPTION_PROMPT)
    except OpenRouterError as e:
        print(f"[ingest] Caption failed for {file_name}: {e}")
        return f"Image: {Path(file_path).stem}"


def _prepare_chunks(
    chunks: List[Dict[str, Any]], file_name: str, cached: Optional[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    cached_caption = (cached or {}).get("caption")
    prepared = []
    for chunk in chunks:
        if chunk.get("modality") == "image" and chunk.get("file_path"):
            if cached_caption:
                caption = cached_caption
            else:
                caption = _caption_image(chunk["file_path"], file_name)
            prepared.append({**chunk, "text": caption})
        else:
            prepared.append(chunk)
    return prepared


# ── Chunk ID ───────────────────────────────────────────────────────────────────


def _chunk_id(file_name: str, chunk_index: int) -> str:
    return hashlib.md5(f"{file_name}::{chunk_index}".encode()).hexdigest()


PROFILE_CHUNK_INDEX = -1


# ── Profile building (shared by ingest_file and the /enrich backfill) ────────


def _build_and_cache_profile(
    file_name: str, enrich_source: str, sha256: Optional[str], cached_profile: Optional[enrich.FileProfile]
) -> Optional[enrich.FileProfile]:
    if cached_profile is not None:
        return cached_profile
    profile = enrich.build_profile(file_name, enrich_source)
    if profile is not None and sha256:
        enrich.put_cached(sha256, profile=profile)
    return profile


def _chunk_metadatas(
    chunks: List[Dict[str, Any]], file_name: str, folder_path: str, profile: Optional[enrich.FileProfile]
) -> List[Dict[str, Any]]:
    summary = profile["summary"] if profile else ""
    category = profile["category"] if profile else ""
    keywords = ", ".join(profile["keywords"]) if profile else ""
    return [
        {
            "file_name": file_name,
            "chunk_index": c["chunk_index"],
            "modality": c.get("modality", "text"),
            "page": str(c.get("page") or ""),
            "chunk_type": "content",
            "folder_path": folder_path,
            "summary": summary,
            "category": category,
            "keywords": keywords,
        }
        for c in chunks
    ]


# ── API models ─────────────────────────────────────────────────────────────────


class IngestRequest(BaseModel):
    file_path: str
    file_name: str
    user_id: str
    folder_path: str = ""


class DeleteRequest(BaseModel):
    file_name: str
    user_id: str


class MoveRequest(BaseModel):
    old_name: str  # previous file_name stored in metadata
    new_name: str  # new file_name (after rename or folder move)
    new_folder_path: str = ""
    user_id: str


class EnrichRequest(BaseModel):
    file_path: Optional[str] = None
    file_name: str
    user_id: str


# ── Endpoints ──────────────────────────────────────────────────────────────────


@router.get("/indexed")
def get_indexed_files(user_id: str):
    try:
        collection = get_collection(user_id)
        if collection.count() == 0:
            return {"files": []}
        results = collection.get(include=["metadatas"])
        names = list({m["file_name"] for m in results["metadatas"]})
        return {"files": names}
    except Exception as e:
        print(f"[ingest] Error listing indexed files: {e}")
        return {"files": []}


@router.get("/profiles-missing")
def get_files_missing_profiles(user_id: str):
    """Files with at least one chunk but zero chunk_type='profile' chunk —
    used by the reindex/backfill action to upgrade files indexed before
    enrichment existed."""
    try:
        collection = get_collection(user_id)
        if collection.count() == 0:
            return {"files": []}
        results = collection.get(include=["metadatas"])
        all_files = set()
        profiled_files = set()
        for m in results["metadatas"]:
            all_files.add(m["file_name"])
            if m.get("chunk_type") == "profile":
                profiled_files.add(m["file_name"])
        return {"files": sorted(all_files - profiled_files)}
    except Exception as e:
        print(f"[ingest] Error listing files missing profiles: {e}")
        return {"files": []}


@router.post("/file")
def ingest_file(req: IngestRequest):
    # TEMP DIAGNOSTIC — remove after investigation.
    print(f"[REPRO-WHY][sidecar] /ingest/file hit for {req.file_name!r} (folder={req.folder_path!r}) — full extract+embed+enrich about to run")
    if not os.path.exists(req.file_path):
        return {"status": "error", "detail": "file not found"}
    if not JINA_API_KEY:
        return {"status": "error", "detail": "JINA_API_KEY not configured"}

    try:
        sha256 = None
        cached: Optional[Dict[str, Any]] = None
        try:
            sha256 = enrich.file_sha256(req.file_path)
            cached = enrich.get_cached(sha256)
        except OSError as e:
            print(f"[ingest] Could not hash {req.file_name}: {e}")

        chunks = extract(req.file_path)
        if not chunks:
            return {"status": "skipped", "detail": "no extractable content"}

        chunks = _prepare_chunks(chunks, req.file_name, cached)
        print(f"[ingest] {req.file_name}: {len(chunks)} chunks, embedding with Jina...")

        modality = chunks[0].get("modality", "text") if chunks else "text"
        profile: Optional[enrich.FileProfile] = None
        if modality in ENRICHABLE_MODALITIES:
            enrich_source = "\n".join(c["text"] for c in chunks)[: enrich.MAX_ENRICH_CHARS]
            cached_profile = (cached or {}).get("profile")
            profile = _build_and_cache_profile(req.file_name, enrich_source, sha256, cached_profile)

        docs = [c["text"] for c in chunks]
        ids = [_chunk_id(req.file_name, c["chunk_index"]) for c in chunks]
        metadatas = _chunk_metadatas(chunks, req.file_name, req.folder_path, profile)

        if profile is not None:
            ids.append(_chunk_id(req.file_name, PROFILE_CHUNK_INDEX))
            docs.append(profile["summary"])
            metadatas.append(
                {
                    "file_name": req.file_name,
                    "chunk_index": PROFILE_CHUNK_INDEX,
                    "modality": modality,
                    "page": "",
                    "chunk_type": "profile",
                    "folder_path": req.folder_path,
                    "summary": profile["summary"],
                    "category": profile["category"],
                    "keywords": ", ".join(profile["keywords"]),
                }
            )

        embeddings = embed_texts(docs, req.file_name)

        collection = get_collection(req.user_id)
        for i in range(0, len(ids), CHROMA_BATCH_SIZE):
            collection.upsert(
                ids=ids[i : i + CHROMA_BATCH_SIZE],
                embeddings=embeddings[i : i + CHROMA_BATCH_SIZE],
                documents=docs[i : i + CHROMA_BATCH_SIZE],
                metadatas=metadatas[i : i + CHROMA_BATCH_SIZE],
            )

        print(f"[ingest] ✅ {req.file_name}: {len(chunks)} chunks stored" + (" (+profile)" if profile else ""))
        return {"status": "ok", "chunks": len(chunks), "file": req.file_name, "profiled": profile is not None}

    except Exception as e:
        print(f"[ingest] Error ingesting {req.file_name}: {e}")
        return {"status": "error", "detail": str(e)}


@router.post("/enrich")
def enrich_file(req: EnrichRequest):
    """Backfill: build/replace a file's profile from chunks ALREADY in
    ChromaDB — no re-extraction, no re-embedding of body content. Patches
    summary/category onto every existing chunk and upserts the profile
    chunk."""
    try:
        collection = get_collection(req.user_id)
        existing = collection.get(
            where={"$and": [{"file_name": req.file_name}, {"chunk_type": "content"}]},
            include=["documents", "metadatas"],
        )
        if not existing["ids"]:
            return {"status": "skipped", "detail": "no content chunks found for file"}

        modality = existing["metadatas"][0].get("modality", "text")
        folder_path = existing["metadatas"][0].get("folder_path", "")
        if modality not in ENRICHABLE_MODALITIES:
            return {"status": "skipped", "detail": f"modality '{modality}' is not enrichable"}

        enrich_source = "\n".join(existing["documents"])[: enrich.MAX_ENRICH_CHARS]

        sha256 = None
        if req.file_path and os.path.exists(req.file_path):
            try:
                sha256 = enrich.file_sha256(req.file_path)
            except OSError:
                sha256 = None

        profile = enrich.build_profile(req.file_name, enrich_source)
        if profile is None:
            return {"status": "error", "detail": "profile generation failed"}
        if sha256:
            enrich.put_cached(sha256, profile=profile)

        summary, category, keywords = profile["summary"], profile["category"], ", ".join(profile["keywords"])
        collection.update(
            ids=existing["ids"],
            metadatas=[
                {**m, "summary": summary, "category": category, "keywords": keywords}
                for m in existing["metadatas"]
            ],
        )

        profile_id = _chunk_id(req.file_name, PROFILE_CHUNK_INDEX)
        embedding = embed_texts([summary], req.file_name)[0]
        collection.upsert(
            ids=[profile_id],
            embeddings=[embedding],
            documents=[summary],
            metadatas=[
                {
                    "file_name": req.file_name,
                    "chunk_index": PROFILE_CHUNK_INDEX,
                    "modality": modality,
                    "page": "",
                    "chunk_type": "profile",
                    "folder_path": folder_path,
                    "summary": summary,
                    "category": category,
                    "keywords": keywords,
                }
            ],
        )
        return {"status": "ok", "file": req.file_name}
    except Exception as e:
        print(f"[ingest] Error enriching {req.file_name}: {e}")
        return {"status": "error", "detail": str(e)}


@router.patch("/move")
def move_file_embeddings(req: MoveRequest):
    """
    Update ChromaDB metadata when a file is renamed or moved to a different
    folder. Reuses existing embeddings — no re-ingestion needed.
    """
    # TEMP DIAGNOSTIC — remove after investigation.
    print(f"[REPRO-WHY][sidecar] /ingest/move hit: {req.old_name!r} -> {req.new_name!r} (folder={req.new_folder_path!r}) — metadata-only, embeddings reused, NO re-embedding")
    try:
        collection = get_collection(req.user_id)

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

        new_ids = []
        new_metadatas = []
        for i, meta in enumerate(old_metadatas):
            chunk_index = meta.get("chunk_index", i)
            new_ids.append(_chunk_id(req.new_name, chunk_index))
            new_metadatas.append(
                {
                    **meta,
                    "file_name": req.new_name,
                    "folder_path": req.new_folder_path,
                }
            )

        collection.delete(ids=old_ids)

        for i in range(0, len(new_ids), CHROMA_BATCH_SIZE):
            collection.upsert(
                ids=new_ids[i : i + CHROMA_BATCH_SIZE],
                embeddings=old_embeddings[i : i + CHROMA_BATCH_SIZE],
                documents=old_documents[i : i + CHROMA_BATCH_SIZE],
                metadatas=new_metadatas[i : i + CHROMA_BATCH_SIZE],
            )

        print(
            f"[ingest] ✅ Moved embeddings: {req.old_name} → {req.new_name} "
            f"({len(new_ids)} chunks, folder={req.new_folder_path!r})"
        )
        return {"status": "ok", "chunks": len(new_ids)}

    except Exception as e:
        print(f"[ingest] Error moving embeddings {req.old_name} → {req.new_name}: {e}")
        return {"status": "error", "detail": str(e)}


@router.delete("/file")
def delete_file(req: DeleteRequest):
    # TEMP DIAGNOSTIC — remove after investigation.
    print(f"[REPRO-WHY][sidecar] DELETE /ingest/file hit for {req.file_name!r}")
    try:
        collection = get_collection(req.user_id)
        results = collection.get(where={"file_name": req.file_name})
        if results["ids"]:
            collection.delete(ids=results["ids"])
        return {"status": "ok", "deleted": len(results["ids"])}
    except Exception as e:
        print(f"[ingest] Error deleting {req.file_name}: {e}")
        return {"status": "error", "detail": str(e)}
