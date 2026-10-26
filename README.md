# duckietown

People today have large amounts of documents, pictures, and files that are saved either in the Cloud or on some type of local-storage device. However, traditional file systems are structured in such a way that they rely on file name and folder structure for the storage/organization of files and thus do not provide efficient retrieval methods from a user's perspective if the user remembers only what is contained within a file. The goal of this project is to create a Smart AI-Based Vectorized Cloud File System enabling a user to perform content-based searches through the use of artificial intelligence to find files.

## What's actually built

A desktop app (Wails v2 + Go backend, React/TypeScript frontend) backed by
Supabase (Postgres for metadata + Storage for file blobs) and a Python
FastAPI sidecar that handles content extraction, embeddings (Jina CLIP v2),
and RAG chat (Google Gemma via OpenRouter). Embeddings live locally in
ChromaDB — search never leaves the machine.

Full architecture, data flow diagrams, and the current restructuring plan
live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Running it

Requires Go, Node, and Python (with a venv) on your machine, plus a
Supabase project and (for AI features) Jina/OpenRouter API keys.

```bash
# from duckietown/
wails dev
```

This builds the Go backend, starts the Vite dev server, and opens the
desktop window. The Go app spawns the Python sidecar itself once a user is
logged in and a vault folder is set — it is not started manually.

**Sidecar setup** (one-time; venv already present under
`duckietown/sidecar/.venv`):

```bash
cd duckietown/sidecar
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
```

**Build checks** (no dev server):

```bash
cd duckietown/frontend && npm run build   # frontend only
cd duckietown && go build ./...           # backend only
```

### Environment variables

Config lives in `duckietown/.env` and/or `duckietown/.env.local` (both
gitignored; `.env.local` wins when both define a key). Copy
`duckietown/.env.example` and fill in real values:

| Variable | Required for | Notes |
|---|---|---|
| `SUPABASE_URL` | everything (auth, storage, db) | Supabase project URL |
| `SUPABASE_KEY` | everything | Supabase publishable/anon key |
| `OPENROUTER_API_KEY` | AI chat, image captioning, organise-intent parsing | sidecar-only, forwarded by `sidecar.go` |
| `OPENROUTER_MODEL` | — | optional, defaults to `google/gemma-3-27b-it`; only affects chat |
| `JINA_API_KEY` | embeddings (ingest + semantic search) | sidecar-only |

Without `OPENROUTER_API_KEY`/`JINA_API_KEY`, the app still builds, launches,
handles auth, vault selection, and local file sync — but ingestion, semantic
search, and chat fail once a vault has files.

### First-run auth

There's no session on a fresh machine, so the app opens to the Google OAuth
sign-in screen. OAuth runs through a local callback server on port `49155`
— that redirect URL must be registered in Supabase under
Authentication → URL Configuration.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture, data
  flow diagrams, current component layout, and the restructuring plan/decision
  log.
- [`CLAUDE.md`](CLAUDE.md) — repo layout and instructions for AI coding
  agents working in this codebase.
