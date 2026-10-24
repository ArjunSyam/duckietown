# Duckietown

Smart AI-based vectorized cloud file system. Desktop app (Wails v2 + Go) with a
React/TypeScript frontend, backed by Supabase (Postgres + Storage) and a Python
FastAPI sidecar that handles embeddings, OCR-less content extraction, and RAG chat.

See `README.md` for the project pitch and `TECHNICAL_IMPLEMENTATION.md` for the
full architecture writeup (components, data flow, event names, etc.).

## Layout

- `duckietown/` — the actual app (Go backend + `frontend/` React app + `sidecar/` Python service). This is the Wails project root (`wails.json`, `go.mod` live here).
- `duckietown/sidecar/` — FastAPI service (ingest, search, chat). Has its own `.venv/`.
- `duckietown/frontend/` — Vite + React + TypeScript + shadcn/ui.

## Running it

From `duckietown/`:

```
wails dev
```

This builds the Go backend, starts the Vite dev server, and opens the desktop
window. The Go app spawns the Python sidecar itself (`sidecar.go`) once a user
is logged in and a vault folder is set — it is not started manually.

Sidecar venv (already set up under `duckietown/sidecar/.venv`); to recreate:

```
cd duckietown/sidecar
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
```

Frontend-only build check: `cd duckietown/frontend && npm run build`.
Backend-only build check: `cd duckietown && go build ./...`.

## Environment variables

Config lives in `duckietown/.env` and/or `duckietown/.env.local` (both
gitignored; `.env.local` wins when both define a key — see `NewApp()` in
`app.go`). `duckietown/.env.example` documents the names with no values.

| Variable | Required for | Notes |
|---|---|---|
| `SUPABASE_URL` | everything (auth, storage, db) | Supabase project URL |
| `SUPABASE_KEY` | everything | Supabase publishable/anon key |
| `OPENROUTER_API_KEY` | AI chat, image captioning, organise-intent parsing | sidecar-only, forwarded by `sidecar.go` |
| `OPENROUTER_MODEL` | — | optional, defaults to `google/gemma-3-27b-it`; only affects chat (`search.py`) — image captioning and organise-intent parsing use the hardcoded `CAPTION_MODEL` in `sidecar/ingest.py` |
| `JINA_API_KEY` | embeddings (ingest + semantic search) | sidecar-only, read directly from process env by `ingest.py`/`search.py` |

Without `OPENROUTER_API_KEY`/`JINA_API_KEY`, the app still builds, launches,
handles auth, vault selection, and local file sync — but ingestion, semantic
search, and chat will fail once a vault has files, since the sidecar's calls
to Jina/OpenRouter will error out.

## First-run auth note

There is no session on a fresh machine (`%AppData%/duckietown/session.json`
is absent), so the app opens to the Google OAuth sign-in screen. OAuth runs
through a local callback server on port `49155` — that redirect URL must be
registered in Supabase under Authentication → URL Configuration.
