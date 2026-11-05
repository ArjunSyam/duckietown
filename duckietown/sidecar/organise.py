"""
organise.py — search wide -> model judges -> plan. Pure computation, no
state: the Go side owns the pending-plan store (with TTL) and does the
actual moving only after the user confirms in the UI.
"""

import json
from typing import Any, Dict, List, Optional

from config import INTENT_MODEL
from json_utils import strip_json_fences as _strip_json_fences
from openrouter_client import OpenRouterError, chat_completion
from retrieval import search_files

JUDGE_TOP_K = 30

_INTENT_SYSTEM_PROMPT = """You are a file organisation assistant. Determine if the user's message is a request to organise/group/move files into folders.

If it IS a SPECIFIC organise request (names a type, topic, or theme), respond with ONLY this JSON:
{
  "is_organise": true,
  "query": "<semantic search query to find matching files>",
  "folder_name": "<name for the new folder>",
  "type_filter": "<one of: image, text, audio, video, or null>"
}

If it IS an organise request but TOO VAGUE to act on directly (e.g. "organise everything", "clean up my files", "sort my vault"), respond with ONLY this JSON instead — propose 2 to 4 sensible groupings instead of guessing one:
{
  "is_organise": true,
  "proposed_groupings": [
    {"folder_name": "<name>", "description": "<one short sentence on what would go here>"},
    ...
  ]
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

_JUDGE_SYSTEM_PROMPT = """You are judging which files actually match a file-organisation instruction, given a list of candidate files (each with its name, current folder, AI-assigned category, AI summary, and a content snippet).

Respond with ONLY a JSON array (no markdown fences, no explanation) of the files that genuinely match, each as:
{"file_name": "<exact file name from the candidate list>", "reason": "<one short sentence why this file matches>"}

Only include files that truly belong. Exclude anything irrelevant or borderline. If no candidates match, respond with an empty array: []"""


def parse_intent(message: str) -> Dict[str, Any]:
    """Returns one of:
      {"is_organise": false}
      {"is_organise": true, "query", "folder_name", "type_filter"}
      {"is_organise": true, "proposed_groupings": [...]}
      {"is_organise": false, "error": str}
    """
    try:
        resp = chat_completion(
            model=INTENT_MODEL,
            messages=[
                {"role": "system", "content": _INTENT_SYSTEM_PROMPT},
                {"role": "user", "content": message},
            ],
            max_tokens=400,
            temperature=0.0,
            timeout=20.0,
        )
        raw = resp["choices"][0]["message"]["content"].strip()
        result = json.loads(_strip_json_fences(raw))
        if not isinstance(result, dict):
            raise ValueError("intent response was not a JSON object")
        return result
    except (OpenRouterError, json.JSONDecodeError, KeyError, ValueError, TypeError) as e:
        print(f"[organise] intent parse error: {e}")
        return {"is_organise": False, "error": str(e)}


def _parse_judge_response(raw: str, valid_names: set) -> Optional[List[Dict[str, str]]]:
    try:
        data = json.loads(_strip_json_fences(raw))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list):
        return None
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        fname = item.get("file_name")
        reason = item.get("reason", "")
        if isinstance(fname, str) and fname in valid_names:
            out.append({"file_name": fname, "reason": str(reason)[:200] or "matched by search"})
    return out


def _judge_candidates(instruction: str, candidates: List[Dict[str, Any]]) -> Optional[List[Dict[str, str]]]:
    if not candidates:
        return []

    valid_names = {c["file_name"] for c in candidates}
    candidate_desc = "\n".join(
        f"- {c['file_name']} (folder: {c.get('folder_path') or '(root)'}, "
        f"category: {c.get('category') or 'unknown'}): "
        f"{c.get('summary') or c.get('snippet', '')[:150]}"
        for c in candidates
    )
    user_content = f"Instruction: {instruction}\n\nCandidate files:\n{candidate_desc}"

    for attempt in range(2):
        try:
            resp = chat_completion(
                model=INTENT_MODEL,
                messages=[
                    {"role": "system", "content": _JUDGE_SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                max_tokens=1500,
                temperature=0.0,
                timeout=30.0,
            )
            raw = resp["choices"][0]["message"]["content"].strip()
            judged = _parse_judge_response(raw, valid_names)
            if judged is not None:
                return judged
            print(f"[organise] judge returned invalid JSON (attempt {attempt + 1}/2): {raw[:200]!r}")
        except OpenRouterError as e:
            print(f"[organise] judge call failed (attempt {attempt + 1}/2): {e}")
    return None


def build_plan(user_id: str, instruction: str, *, current_folder: str = "") -> Dict[str, Any]:
    """Never raises. Returns one of:
      {"needs_clarification": true, "proposed_groupings": [...]}
      {"needs_clarification": false, "target_folder": str, "moves": [...]}
      {"needs_clarification": false, "target_folder": "", "moves": [], "error": str}
    """
    intent = parse_intent(instruction)
    if intent.get("error"):
        return {"needs_clarification": False, "target_folder": "", "moves": [], "error": intent["error"]}
    if intent.get("proposed_groupings"):
        return {"needs_clarification": True, "proposed_groupings": intent["proposed_groupings"]}
    if not intent.get("is_organise"):
        return {"needs_clarification": False, "target_folder": "", "moves": [], "error": "not an organise request"}

    query = intent.get("query") or instruction
    folder_name = intent.get("folder_name") or "Organised"
    type_filter = intent.get("type_filter") or None

    out = search_files(user_id, query, type_filter=type_filter, top_k=JUDGE_TOP_K, min_score=0.0)
    candidates = out["results"]
    if not candidates:
        return {
            "needs_clarification": False,
            "target_folder": folder_name,
            "moves": [],
            "error": f"no matching files found for: {query}",
        }

    judged = _judge_candidates(instruction, candidates)
    if judged is None:
        # Both judge attempts failed — fall back to "everything search found
        # matches", rather than silently proposing an empty plan.
        judged = [{"file_name": c["file_name"], "reason": "matched by search"} for c in candidates]

    by_name = {c["file_name"]: c for c in candidates}
    target_path = f"{current_folder}/{folder_name}" if current_folder else folder_name

    moves = [
        {
            "file_name": j["file_name"],
            "folder_path": by_name[j["file_name"]]["folder_path"],
            "reason": j["reason"],
        }
        for j in judged
        if j["file_name"] in by_name and by_name[j["file_name"]]["folder_path"] != target_path
    ]
    return {"needs_clarification": False, "target_folder": target_path, "moves": moves}
