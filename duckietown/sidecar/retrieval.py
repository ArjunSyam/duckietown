"""
retrieval.py — search_files(): the ONE retrieval path shared by
/search/query, chat's tool loop, and the organise flow's wide search.
Dedupes by file across content AND profile chunks; explicit-filename
matching is a step feeding into this function, not a parallel pipeline.
"""

import mimetypes
from typing import Any, Dict, List, Optional, TypedDict

from chroma_store import get_collection
from jina_client import embed_query

RAW_FETCH_MULTIPLIER = 4
MIN_RAW_FETCH = 20
SNIPPET_LEN = 300
FALLBACK_TOP_N = 3


class FileHit(TypedDict):
    file_name: str
    folder_path: str
    mime_type: str
    snippet: str
    summary: str
    category: str
    score: float
    modality: str


def _mime_for(file_name: str) -> str:
    return mimetypes.guess_type(file_name)[0] or "application/octet-stream"


def _explicit_filename_matches(query: str, collection) -> List[str]:
    """Any filename (with or without extension) that literally appears in
    the query string. Ported from the old chat-only _extract_mentioned_filenames
    — now a step inside search_files instead of a parallel retrieval path."""
    try:
        results = collection.get(include=["metadatas"])
        all_files = list({m["file_name"] for m in results["metadatas"]})
    except Exception:
        return []

    q = query.lower()
    matches = []
    for fname in all_files:
        name_lower = fname.lower()
        stem = name_lower.rsplit(".", 1)[0]
        if name_lower in q or stem in q:
            matches.append(fname)
    return matches


def _fetch_one_content_chunk(collection, file_name: str) -> Optional[Dict[str, Any]]:
    chunk = collection.get(
        where={"$and": [{"file_name": file_name}, {"chunk_type": "content"}]},
        include=["documents", "metadatas"],
        limit=1,
    )
    if not chunk["ids"]:
        return None
    return {"document": chunk["documents"][0], "metadata": chunk["metadatas"][0]}


def search_files(
    user_id: str,
    query: str,
    *,
    type_filter: Optional[str] = None,
    folder: Optional[str] = None,
    top_k: int = 10,
    min_score: Optional[float] = None,
) -> Dict[str, Any]:
    collection = get_collection(user_id)
    count = collection.count()
    if count == 0:
        return {"results": [], "total_indexed": 0}

    clauses = []
    if type_filter:
        clauses.append({"modality": type_filter})
    if folder is not None:
        clauses.append({"folder_path": folder})
    where = None
    if len(clauses) == 1:
        where = clauses[0]
    elif len(clauses) > 1:
        where = {"$and": clauses}

    query_emb = embed_query(query)
    raw_n = min(count, max(top_k * RAW_FETCH_MULTIPLIER, MIN_RAW_FETCH))
    results = collection.query(
        query_embeddings=[query_emb],
        n_results=raw_n,
        where=where,
        include=["documents", "metadatas", "distances"],
    )

    best_by_file: Dict[str, FileHit] = {}
    docs = results["documents"][0] if results["documents"] else []
    metas = results["metadatas"][0] if results["metadatas"] else []
    dists = results["distances"][0] if results["distances"] else []

    for doc, meta, dist in zip(docs, metas, dists):
        sim = max(0.0, 1.0 - dist / 2.0)
        fname = meta["file_name"]
        is_profile = meta.get("chunk_type") == "profile"
        cur = best_by_file.get(fname)
        if cur is None:
            best_by_file[fname] = FileHit(
                file_name=fname,
                folder_path=meta.get("folder_path", ""),
                mime_type=_mime_for(fname),
                snippet="" if is_profile else doc[:SNIPPET_LEN],
                summary=meta.get("summary", ""),
                category=meta.get("category", ""),
                score=sim,
                modality=meta.get("modality", "text"),
            )
        else:
            if sim > cur["score"]:
                cur["score"] = sim
            if not is_profile and not cur["snippet"]:
                cur["snippet"] = doc[:SNIPPET_LEN]

    for fname in _explicit_filename_matches(query, collection):
        if type_filter or folder is not None:
            # An explicit name match ignores the filters the caller asked
            # for (type/folder) — skip it rather than surface a file outside
            # the requested scope.
            continue
        if fname not in best_by_file:
            chunk = _fetch_one_content_chunk(collection, fname)
            if chunk is None:
                continue
            meta = chunk["metadata"]
            best_by_file[fname] = FileHit(
                file_name=fname,
                folder_path=meta.get("folder_path", ""),
                mime_type=_mime_for(fname),
                snippet=chunk["document"][:SNIPPET_LEN],
                summary=meta.get("summary", ""),
                category=meta.get("category", ""),
                score=1.0,
                modality=meta.get("modality", "text"),
            )
        else:
            best_by_file[fname]["score"] = max(best_by_file[fname]["score"], 0.99)

    hits = list(best_by_file.values())
    if min_score is not None:
        hits = [h for h in hits if h["score"] >= min_score]
    elif hits:
        above = [h for h in hits if h["score"] >= 0.3]
        hits = above if above else sorted(hits, key=lambda h: h["score"], reverse=True)[:FALLBACK_TOP_N]

    hits.sort(key=lambda h: h["score"], reverse=True)
    return {"results": hits[:top_k], "total_indexed": count}
