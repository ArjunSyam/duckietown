"""
config.py — Central env/constants module. No other sidecar module may be
imported here; every other module imports FROM this one, never the reverse,
so there's exactly one place that reads os.environ for model/API config.
"""

import os
from pathlib import Path

DEFAULT_MODEL = "anthropic/claude-haiku-5.5"


def _resolve_model(primary: str, *aliases: str) -> str:
    for name in (primary, *aliases):
        val = os.environ.get(name)
        if val:
            return val
    return DEFAULT_MODEL


# Deprecated alias: OPENROUTER_MODEL still works, but only as a fallback for
# CHAT_MODEL — new deployments should set CHAT_MODEL directly.
CHAT_MODEL = _resolve_model("CHAT_MODEL", "OPENROUTER_MODEL")
INTENT_MODEL = _resolve_model("INTENT_MODEL")
CAPTION_MODEL = _resolve_model("CAPTION_MODEL")
ENRICH_MODEL = _resolve_model("ENRICH_MODEL")

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_REFERER = "https://duckietown.app"

JINA_API_KEY = os.environ.get("JINA_API_KEY", "")
JINA_CLIP_URL = "https://api.jina.ai/v1/embeddings"
JINA_CLIP_MODEL = "jina-clip-v2"

CHROMA_DIR = os.environ.get(
    "CHROMA_DIR",
    str(Path.home() / ".duckietown" / "chromadb"),
)
CACHE_DIR = os.environ.get(
    "DUCKIETOWN_CACHE_DIR",
    str(Path.home() / ".duckietown" / "cache"),
)
