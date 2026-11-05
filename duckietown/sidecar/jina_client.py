"""
jina_client.py — Jina CLIP v2 embedding calls, shared by ingest (batch
embedding of chunks) and retrieval (single query embedding).
"""

import time
from typing import Any, Dict, List

import requests

from config import JINA_API_KEY, JINA_CLIP_MODEL, JINA_CLIP_URL

JINA_BATCH_SIZE = 8
MAX_RETRIES = 5
RETRY_BASE_DELAY = 2.0


def _headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {JINA_API_KEY}",
        "Content-Type": "application/json",
    }


def embed_query(text: str) -> List[float]:
    payload = {"model": JINA_CLIP_MODEL, "input": [{"text": text}], "normalized": True}
    resp = requests.post(JINA_CLIP_URL, headers=_headers(), json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


def _embed_batch_with_retry(texts: List[str]) -> List[List[float]]:
    inputs = [{"text": t} for t in texts]
    payload = {"model": JINA_CLIP_MODEL, "input": inputs, "normalized": True}

    delay = RETRY_BASE_DELAY
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(JINA_CLIP_URL, headers=_headers(), json=payload, timeout=60)
            if resp.status_code == 429:
                wait = max(int(resp.headers.get("Retry-After", delay)), delay)
                print(f"[jina] Rate limited, waiting {wait:.1f}s (attempt {attempt}/{MAX_RETRIES})")
                time.sleep(wait)
                delay *= 2
                continue
            resp.raise_for_status()
            ordered = sorted(resp.json()["data"], key=lambda x: x["index"])
            return [item["embedding"] for item in ordered]
        except requests.exceptions.HTTPError as e:
            if attempt == MAX_RETRIES:
                raise
            print(f"[jina] HTTP error {e}, retrying in {delay}s...")
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"Failed after {MAX_RETRIES} retries")


def embed_texts(texts: List[str], label: str = "") -> List[List[float]]:
    """Batch-embeds a list of chunk texts, 8 at a time, 0.5s between
    batches, with 429/backoff handling."""
    all_embeddings: List[List[float]] = []
    total_batches = -(-len(texts) // JINA_BATCH_SIZE)
    for i in range(0, len(texts), JINA_BATCH_SIZE):
        if label:
            print(f"[jina] {label}: batch {i // JINA_BATCH_SIZE + 1}/{total_batches}")
        batch_embs = _embed_batch_with_retry(texts[i : i + JINA_BATCH_SIZE])
        all_embeddings.extend(batch_embs)
        if i + JINA_BATCH_SIZE < len(texts):
            time.sleep(0.5)
    return all_embeddings
