"""
chroma_store.py — The single ChromaDB PersistentClient + per-user
collection accessor, shared by ingest and retrieval.
"""

import os
from pathlib import Path

os.environ["ANONYMIZED_TELEMETRY"] = "False"
os.environ["CHROMA_TELEMETRY"] = "False"

import chromadb

from config import CHROMA_DIR

Path(CHROMA_DIR).mkdir(parents=True, exist_ok=True)
_chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)


def get_collection(user_id: str) -> chromadb.Collection:
    safe_id = "user_" + user_id.replace("-", "_")
    return _chroma_client.get_or_create_collection(
        name=safe_id,
        metadata={"hnsw:space": "cosine"},
    )
