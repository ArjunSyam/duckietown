"""
rename.py — search wide -> model proposes new names -> plan. Mirrors
organise.py's shape: pure computation, no state. The Go side owns the
pending-plan store (shared TTL mechanics with organise, separate
instance) and does the actual renaming only after the user confirms.

Deliberately simpler than organise.py: no "vague bulk instruction ->
proposed groupings" branch, and no explicit ambiguity-resolution code
path — this is a chat-only tool, and the chat system prompt already
instructs the model to ask which file the user means, in plain chat,
before ever calling this tool.
"""

import json
from typing import Any, Dict, List, Optional

from config import INTENT_MODEL
from json_utils import strip_json_fences
from openrouter_client import OpenRouterError, chat_completion
from retrieval import search_files

RENAME_TOP_K = 30

_RENAME_INTENT_SYSTEM_PROMPT = """You are a file-renaming assistant. Determine what to search for to find the file(s) the user wants renamed.

Respond with ONLY this JSON:
{"query": "<semantic search query>", "type_filter": "<one of: image, text, audio, video, or null>"}

Rules for type_filter: "image" for images/photos/screenshots, "text" for documents/pdfs/spreadsheets, "audio" for audio/music, "video" for videos, null otherwise.
Never include any explanation, only the JSON."""

_NAMING_SYSTEM_PROMPT = """You are proposing new file names for a batch of candidate files, following the user's renaming instruction.

Respond with ONLY a JSON array (no markdown fences, no explanation):
[{"file_name": "<exact current name from the candidate list>", "new_name": "<proposed new name>", "reason": "<one short sentence>"}]

Rules:
- Keep the original extension unless the user's instruction explicitly asks to change it.
- Only include files that should actually be renamed — omit any that should keep their current name.
- For content-based instructions (e.g. "give my screenshots descriptive names"), base the new name on the file's category/summary/snippet.
- For pattern-based instructions (e.g. "Vendor - YYYY-MM-DD"), follow the pattern literally using values you can infer from the file's content/summary; if you cannot infer a required value for a file, omit that file rather than invent one.
- If no candidates should be renamed, respond with an empty array: []"""


def parse_rename_intent(instruction: str) -> Dict[str, Any]:
    """Never raises. Falls back to {"query": instruction, "type_filter": None}."""
    try:
        resp = chat_completion(
            model=INTENT_MODEL,
            messages=[
                {"role": "system", "content": _RENAME_INTENT_SYSTEM_PROMPT},
                {"role": "user", "content": instruction},
            ],
            max_tokens=200,
            temperature=0.0,
            timeout=20.0,
        )
        raw = resp["choices"][0]["message"]["content"].strip()
        result = json.loads(strip_json_fences(raw))
        if not isinstance(result, dict):
            raise ValueError("rename intent response was not a JSON object")
        return result
    except (OpenRouterError, json.JSONDecodeError, KeyError, ValueError, TypeError) as e:
        print(f"[rename] intent parse error: {e}")
        return {"query": instruction, "type_filter": None}


def _parse_naming_response(raw: str, valid_names: set) -> Optional[List[Dict[str, str]]]:
    try:
        data = json.loads(strip_json_fences(raw))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list):
        return None
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        fname = item.get("file_name")
        new_name = item.get("new_name")
        reason = item.get("reason", "")
        if (
            isinstance(fname, str)
            and fname in valid_names
            and isinstance(new_name, str)
            and new_name.strip()
        ):
            out.append({"file_name": fname, "new_name": new_name.strip(), "reason": str(reason)[:200] or "renamed"})
    return out


def _propose_names(instruction: str, candidates: List[Dict[str, Any]]) -> Optional[List[Dict[str, str]]]:
    """Mirrors organise._judge_candidates's retry-once shape exactly."""
    if not candidates:
        return []

    valid_names = {c["file_name"] for c in candidates}
    candidate_desc = "\n".join(
        f"- {c['file_name']} (category: {c.get('category') or 'unknown'}): "
        f"{c.get('summary') or c.get('snippet', '')[:150]}"
        for c in candidates
    )
    user_content = f"Instruction: {instruction}\n\nCandidate files:\n{candidate_desc}"

    for attempt in range(2):
        try:
            resp = chat_completion(
                model=INTENT_MODEL,
                messages=[
                    {"role": "system", "content": _NAMING_SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                max_tokens=1500,
                temperature=0.2,
                timeout=30.0,
            )
            raw = resp["choices"][0]["message"]["content"].strip()
            proposed = _parse_naming_response(raw, valid_names)
            if proposed is not None:
                return proposed
            print(f"[rename] naming returned invalid JSON (attempt {attempt + 1}/2): {raw[:200]!r}")
        except OpenRouterError as e:
            print(f"[rename] naming call failed (attempt {attempt + 1}/2): {e}")
    return None


def build_plan(user_id: str, instruction: str) -> Dict[str, Any]:
    """Never raises. Returns one of:
      {"renames": [{"file_name","folder_path","old_name","new_name","reason"}]}
      {"renames": [], "error": str}
    """
    intent = parse_rename_intent(instruction)
    query = intent.get("query") or instruction
    type_filter = intent.get("type_filter") or None

    out = search_files(user_id, query, type_filter=type_filter, top_k=RENAME_TOP_K, min_score=0.0)
    candidates = out["results"]
    if not candidates:
        return {"renames": [], "error": f"no matching files found for: {query}"}

    proposed = _propose_names(instruction, candidates)
    if proposed is None:
        return {"renames": [], "error": "could not generate names — try rephrasing"}
    if not proposed:
        return {"renames": [], "error": "no files needed renaming"}

    by_name = {c["file_name"]: c for c in candidates}
    renames = [
        {
            "file_name": p["file_name"],
            "folder_path": by_name[p["file_name"]]["folder_path"],
            "old_name": p["file_name"],
            "new_name": p["new_name"],
            "reason": p["reason"],
        }
        for p in proposed
        if p["file_name"] in by_name
    ]
    return {"renames": renames}
