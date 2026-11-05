"""
search.py — Semantic search endpoint, tool-calling RAG chat (SSE), and the
organise-plan endpoints.

POST /search/query          { query, user_id, top_k?, type_filter? }
POST /search/chat           { message, user_id, history?, file_name? }   (SSE)
POST /search/organise-plan  { message, user_id, current_folder? }
POST /search/organise-intent { message, user_id }   ← back-compat, delegates to organise.parse_intent
GET  /search/model
"""

import json
import os
import re
import ssl

ssl._create_default_https_context = ssl._create_unverified_context
os.environ["ANONYMIZED_TELEMETRY"] = "False"
os.environ["CHROMA_TELEMETRY"] = "False"

from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import organise
import rename
from chroma_store import get_collection
from config import CHAT_MODEL, JINA_API_KEY, OPENROUTER_API_KEY
from openrouter_client import OpenRouterError, chat_completion, fake_stream_text
from retrieval import search_files

router = APIRouter()


@router.get("/model")
def get_chat_model():
    """Returns the OpenRouter model id actually used for chat, so the
    frontend can show the real model instead of a hardcoded label."""
    return {"model": CHAT_MODEL}


TOP_K_DEFAULT = 50

# ── Type keyword detection — a convenience ONLY for the plain search bar,
# which has no model deciding type_filter for it. Chat and organise decide
# type_filter explicitly (via tool args / intent parsing), so this heuristic
# intentionally is NOT part of search_files itself. ─────────────────────────

TYPE_KEYWORDS = {
    "image": "image", "images": "image", "photo": "image", "photos": "image",
    "picture": "image", "pictures": "image", "jpg": "image", "jpeg": "image",
    "png": "image", "gif": "image", "screenshot": "image", "screenshots": "image",
    "pdf": "text", "pdfs": "text", "document": "text", "documents": "text",
    "doc": "text", "docx": "text", "word": "text", "spreadsheet": "text",
    "excel": "text", "xlsx": "text", "csv": "text", "text": "text",
    "audio": "audio", "music": "audio", "video": "video", "videos": "video",
}


def _detect_type_filter(query: str) -> Optional[str]:
    words = re.findall(r"\w+", query.lower())
    for word in words:
        if word in TYPE_KEYWORDS:
            return TYPE_KEYWORDS[word]
    return None


# ── API models ─────────────────────────────────────────────────────────────────


class QueryRequest(BaseModel):
    query: str
    user_id: str
    top_k: int = TOP_K_DEFAULT
    type_filter: Optional[str] = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    user_id: str
    history: Optional[List[ChatMessage]] = []
    file_name: Optional[str] = None


class OrganisePlanRequest(BaseModel):
    message: str
    user_id: str
    current_folder: str = ""


class OrganiseIntentRequest(BaseModel):
    message: str
    user_id: str


# ── Search endpoint ────────────────────────────────────────────────────────────


@router.post("/query")
def semantic_query(req: QueryRequest):
    if not JINA_API_KEY:
        return {"results": [], "error": "JINA_API_KEY not configured"}

    try:
        type_filter = req.type_filter or _detect_type_filter(req.query)
        out = search_files(req.user_id, req.query, type_filter=type_filter, top_k=req.top_k)
        results = [
            {
                "file_name": h["file_name"],
                "similarity": round(h["score"], 4),
                "score": round(h["score"], 4),
                "snippet": h["snippet"],
                "modality": h["modality"],
                "page": "",
                "folder_path": h["folder_path"],
                "mime_type": h["mime_type"],
                "summary": h["summary"],
                "category": h["category"],
            }
            for h in out["results"]
        ]
        return {"results": results, "total_indexed": out["total_indexed"], "type_filter": type_filter}

    except Exception as e:
        print(f"[search] Query error: {e}")
        return {"results": [], "error": str(e)}


# ── Chat tools ─────────────────────────────────────────────────────────────────

MAX_TOOL_ITERATIONS = 5
MAX_READ_CHARS = 30_000 * 4

TOOLS_SPEC = [
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": (
                "Search the user's file vault by meaning. Returns matching files with "
                "name, folder, type, a content snippet, and an AI-written summary/category. "
                "Use this whenever the user asks to find, show, or locate files, or when "
                "you need candidates for a question about their files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to search for, in natural language."},
                    "type_filter": {
                        "type": "string",
                        "enum": ["image", "text", "audio", "video"],
                        "description": "Restrict to one file type, if the user asked for one.",
                    },
                    "top_k": {"type": "integer", "description": "Max results to return (default 10)."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "Read a specific file's AI summary/category plus its full extracted text, "
                "by exact or close file name. Use this to answer detailed questions or "
                "produce a summary about one particular file — call search_files first if "
                "you're not sure of the exact name."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name_or_id": {"type": "string", "description": "The file's name (exact or close match)."},
                },
                "required": ["name_or_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_reorganisation",
            "description": (
                "Start a file-reorganisation preview for the user's instruction (e.g. "
                "'put my invoices in one folder'). This moves NOTHING — it only builds a "
                "plan that the user must review and confirm in the UI. Use this whenever "
                "the user asks you to organise, group, sort, or move multiple files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "instruction": {"type": "string", "description": "The organise instruction, in the user's own words."},
                },
                "required": ["instruction"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_rename",
            "description": (
                "Start a file-renaming preview for the user's instruction (e.g. 'rename "
                "my invoices as Vendor - YYYY-MM-DD', or 'give my screenshots descriptive "
                "names'). This renames NOTHING — it only builds a plan the user must "
                "review (and can edit) and confirm in the UI. Use this whenever the user "
                "asks you to rename one or more files. If the instruction could refer to "
                "more than one file ambiguously, ask which file they mean in plain chat "
                "FIRST — do not call this tool until the reference is unambiguous."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "instruction": {
                        "type": "string",
                        "description": "The rename instruction, in the user's own words, with any ambiguity already resolved.",
                    },
                },
                "required": ["instruction"],
            },
        },
    },
]


def _tool_label(fn_name: str, args: Dict[str, Any]) -> str:
    if fn_name == "search_files":
        q = args.get("query", "")
        return f'Searching files for "{q}"…' if q else "Searching files…"
    if fn_name == "read_file":
        name = args.get("name_or_id", "")
        return f"Reading {name}…" if name else "Reading file…"
    if fn_name == "propose_reorganisation":
        return "Preparing a reorganisation preview…"
    if fn_name == "propose_rename":
        return "Preparing a rename preview…"
    return f"Running {fn_name}…"


def _tool_search_files(user_id: str, args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or ""
    if not query:
        return {"results": [], "error": "query is required"}
    return search_files(
        user_id,
        query,
        type_filter=args.get("type_filter"),
        top_k=int(args.get("top_k") or 10),
    )


def _tool_read_file(user_id: str, args: Dict[str, Any]) -> Dict[str, Any]:
    name = (args.get("name_or_id") or "").strip()
    if not name:
        return {"error": "name_or_id is required"}

    collection = get_collection(user_id)

    def _content_chunks(fname: str):
        return collection.get(
            where={"$and": [{"file_name": fname}, {"chunk_type": "content"}]},
            include=["documents", "metadatas"],
        )

    content = _content_chunks(name)
    if not content["ids"]:
        # No exact match — resolve the closest file via search_files.
        hits = search_files(user_id, name, top_k=1).get("results", [])
        if not hits:
            return {"error": f"file not found: {name}"}
        name = hits[0]["file_name"]
        content = _content_chunks(name)
        if not content["ids"]:
            return {"error": f"file not found: {name}"}

    pairs = sorted(
        zip(content["documents"], content["metadatas"]),
        key=lambda p: p[1].get("chunk_index", 0),
    )
    text = "\n".join(doc for doc, _ in pairs)[:MAX_READ_CHARS]

    profile = collection.get(
        where={"$and": [{"file_name": name}, {"chunk_type": "profile"}]},
        include=["documents", "metadatas"],
        limit=1,
    )
    summary = profile["documents"][0] if profile["ids"] else ""
    category = profile["metadatas"][0].get("category", "") if profile["ids"] else ""

    return {"file_name": name, "summary": summary, "category": category, "text": text}


# ── Chat endpoint ──────────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "You are Duckietown AI, an assistant for the user's personal file vault. "
    "Only answer using tool results — never invent files, and never claim a "
    "file exists without having found it via search_files or read_file. "
    "Always cite the exact file names you used. If several files could match "
    "what the user means, ask which one instead of guessing — this applies "
    "before calling propose_reorganisation or propose_rename alike. If you "
    "call propose_reorganisation or propose_rename, tell the user a preview "
    "is ready for them to review (and for renames, edit) and confirm in the "
    "UI — never say files have been moved or renamed; nothing happens until "
    "they confirm there."
)


@router.post("/chat")
async def chat(req: ChatRequest):
    if not OPENROUTER_API_KEY:
        return {"error": "OPENROUTER_API_KEY not set"}

    messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for h in req.history or []:
        messages.append({"role": h.role, "content": h.content})
    user_content = req.message
    if req.file_name:
        user_content = f"[Context file: {req.file_name}]\n{req.message}"
    messages.append({"role": "user", "content": user_content})

    async def event_stream():
        aggregated_sources: Dict[str, float] = {}
        final_text = ""

        for _ in range(MAX_TOOL_ITERATIONS):
            try:
                resp = chat_completion(
                    model=CHAT_MODEL,
                    messages=messages,
                    tools=TOOLS_SPEC,
                    tool_choice="auto",
                    max_tokens=1024,
                    timeout=45.0,
                )
            except OpenRouterError as e:
                print(f"[chat] OpenRouter error for model {CHAT_MODEL}: {e}")
                yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
                yield "data: [DONE]\n\n"
                return

            msg = resp["choices"][0]["message"]
            tool_calls = msg.get("tool_calls")
            if not tool_calls:
                final_text = msg.get("content") or ""
                break

            messages.append(msg)
            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    args = json.loads(tc["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}

                yield f"data: {json.dumps({'type': 'tool_start', 'tool': fn_name, 'label': _tool_label(fn_name, args)})}\n\n"

                if fn_name == "search_files":
                    result = _tool_search_files(req.user_id, args)
                    for r in result.get("results", []):
                        prev = aggregated_sources.get(r["file_name"], 0.0)
                        aggregated_sources[r["file_name"]] = max(prev, r["score"])
                    yield f"data: {json.dumps({'type': 'search_results', 'results': result.get('results', [])})}\n\n"

                elif fn_name == "read_file":
                    result = _tool_read_file(req.user_id, args)
                    if "file_name" in result:
                        prev = aggregated_sources.get(result["file_name"], 0.0)
                        aggregated_sources[result["file_name"]] = max(prev, 1.0)

                elif fn_name == "propose_reorganisation":
                    plan = organise.build_plan(req.user_id, args.get("instruction") or req.message, current_folder="")
                    yield f"data: {json.dumps({'type': 'organise_proposal', **plan})}\n\n"
                    if plan.get("needs_clarification"):
                        result = {"status": "clarification_needed", "proposed_groupings": plan.get("proposed_groupings", [])}
                    elif plan.get("error"):
                        result = {"status": "error", "error": plan["error"]}
                    else:
                        result = {
                            "status": "preview_ready",
                            "target_folder": plan.get("target_folder", ""),
                            "candidate_count": len(plan.get("moves", [])),
                        }

                elif fn_name == "propose_rename":
                    rename_plan = rename.build_plan(req.user_id, args.get("instruction") or req.message)
                    yield f"data: {json.dumps({'type': 'rename_proposal', **rename_plan})}\n\n"
                    if rename_plan.get("error"):
                        result = {"status": "error", "error": rename_plan["error"]}
                    else:
                        result = {"status": "preview_ready", "candidate_count": len(rename_plan.get("renames", []))}

                else:
                    result = {"error": f"unknown tool: {fn_name}"}

                messages.append(
                    {"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(result)[:8000]}
                )
        else:
            # Ran out of iterations — force a final answer with what we have.
            messages.append({"role": "system", "content": "Stop calling tools now and answer with what you have."})
            try:
                resp = chat_completion(model=CHAT_MODEL, messages=messages, max_tokens=2048, timeout=45.0)
                final_text = resp["choices"][0]["message"].get("content") or ""
            except OpenRouterError as e:
                yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
                yield "data: [DONE]\n\n"
                return

        sources = [
            {"file_name": f, "similarity": round(s, 4)}
            for f, s in sorted(aggregated_sources.items(), key=lambda x: x[1], reverse=True)
        ]
        yield f"data: {json.dumps({'type': 'sources', 'files': sources})}\n\n"

        async for ev in fake_stream_text(final_text):
            yield f"data: {json.dumps(ev)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Organise endpoints ─────────────────────────────────────────────────────────


@router.post("/organise-plan")
def organise_plan(req: OrganisePlanRequest):
    if not OPENROUTER_API_KEY:
        return {"needs_clarification": False, "target_folder": "", "moves": [], "error": "OPENROUTER_API_KEY not set"}
    return organise.build_plan(req.user_id, req.message, current_folder=req.current_folder)


@router.post("/organise-intent")
def parse_organise_intent(req: OrganiseIntentRequest):
    """Back-compat endpoint for the (now unused by the new UI, but still
    valid) ParseOrganiseIntent Wails method."""
    if not OPENROUTER_API_KEY:
        return {"is_organise": False, "error": "OPENROUTER_API_KEY not set"}
    return organise.parse_intent(req.message)
