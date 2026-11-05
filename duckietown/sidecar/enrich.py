"""
enrich.py — File-profile generation ("summary + category + keywords") and
the content-hash cache that makes resyncs/renames/moves free of repeat
caption/enrichment API calls.

Cache file: <CACHE_DIR>/file_profiles.json, keyed by SHA-256 of file bytes.
Each entry independently may carry "caption" (images), "profile" (any
text-bearing file), or both. Written atomically (tmp + os.replace) so a
crash mid-write can't corrupt it.
"""

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, TypedDict

from config import CACHE_DIR, ENRICH_MODEL
from openrouter_client import OpenRouterError, chat_completion

CACHE_VERSION = 1
CACHE_FILE = str(Path(CACHE_DIR) / "file_profiles.json")

# ~20K tokens, approximated as chars (no tokenizer dependency needed for a
# rough excerpt cap) at ~4 chars/token.
MAX_ENRICH_CHARS = 20_000 * 4


class FileProfile(TypedDict):
    summary: str
    category: str
    keywords: List[str]


def file_sha256(file_path: str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _load_cache() -> Dict[str, Any]:
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_cache(cache: Dict[str, Any]) -> None:
    Path(CACHE_DIR).mkdir(parents=True, exist_ok=True)
    tmp_path = CACHE_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    os.replace(tmp_path, CACHE_FILE)


def get_cached(sha256: str) -> Optional[Dict[str, Any]]:
    cache = _load_cache()
    entry = cache.get(sha256)
    if entry is None or entry.get("v") != CACHE_VERSION:
        return None
    return entry


def put_cached(
    sha256: str,
    *,
    caption: Optional[str] = None,
    profile: Optional[FileProfile] = None,
) -> None:
    cache = _load_cache()
    entry = cache.get(sha256) or {"v": CACHE_VERSION}
    if entry.get("v") != CACHE_VERSION:
        entry = {"v": CACHE_VERSION}
    if caption is not None:
        entry["caption"] = caption
    if profile is not None:
        entry["profile"] = profile
    cache[sha256] = entry
    _save_cache(cache)


_PROFILE_SYSTEM_PROMPT = (
    "You profile files for a personal file-search index. Given a file name "
    "and an excerpt of its content, respond with ONLY this JSON, no markdown "
    "fences, no explanation:\n"
    '{"summary": "<2-3 sentences on what the file is and what it contains>", '
    '"category": "<one short label, e.g. invoice, receipt, contract, lecture '
    'notes, resume, report, photo, screenshot>", '
    '"keywords": ["<people, organisations, dates, amounts, topics>", ...]}'
)


def build_profile(file_name: str, text: str) -> Optional[FileProfile]:
    """One ENRICH_MODEL call. Returns None on ANY failure — enrichment must
    never fail ingest."""
    excerpt = (text or "")[:MAX_ENRICH_CHARS].strip()
    if not excerpt:
        return None
    try:
        resp = chat_completion(
            model=ENRICH_MODEL,
            messages=[
                {"role": "system", "content": _PROFILE_SYSTEM_PROMPT},
                {"role": "user", "content": f"File name: {file_name}\n\nExcerpt:\n{excerpt}"},
            ],
            max_tokens=400,
            temperature=0.0,
            timeout=30.0,
        )
        raw = resp["choices"][0]["message"]["content"].strip()
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
        data = json.loads(raw)
        keywords = [str(k) for k in (data.get("keywords") or [])][:12]
        return FileProfile(
            summary=str(data.get("summary", ""))[:600],
            category=str(data.get("category", ""))[:60],
            keywords=keywords,
        )
    except (OpenRouterError, json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
        print(f"[enrich] profile failed for {file_name}: {e}")
        return None
