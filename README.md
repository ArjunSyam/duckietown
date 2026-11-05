# duckietown

People today have large amounts of documents, pictures, and files that are saved either in the Cloud or on some type of local-storage device. However, traditional file systems are structured in such a way that they rely on file name and folder structure for the storage/organization of files and thus do not provide efficient retrieval methods from a user's perspective if the user remembers only what is contained within a file. The goal of this project is to create a Smart AI-Based Vectorized Cloud File System enabling a user to perform content-based searches through the use of artificial intelligence to find files.

## What's actually built

A desktop app (Wails v2 + Go backend, React/TypeScript frontend) backed by
Supabase (Postgres for metadata + Storage for file blobs) and a Python
FastAPI sidecar that handles content extraction, embeddings (Jina CLIP v2),
and RAG chat with tool calling (configurable model via OpenRouter, default
Claude Haiku) — including AI-driven file organising and renaming, both as
a search → preview → confirm flow so nothing changes on disk until you
approve it. Embeddings live locally in ChromaDB — search never leaves the
machine. On Windows, the vault folder gets a custom icon and a pinned
entry in Explorer's navigation pane (toggleable, no admin rights needed).

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
| `OPENROUTER_API_KEY` | AI chat, image captioning, file-profile enrichment, organise intent/judging | sidecar-only, forwarded by `sidecar.go` |
| `CHAT_MODEL` / `INTENT_MODEL` / `CAPTION_MODEL` / `ENRICH_MODEL` | chat / organise / captioning / enrichment | each optional, defaults to `anthropic/claude-haiku-5.5`; `OPENROUTER_MODEL` is a deprecated alias for `CHAT_MODEL` |
| `JINA_API_KEY` | embeddings (ingest + semantic search) | sidecar-only |

Without `OPENROUTER_API_KEY`/`JINA_API_KEY`, the app still builds, launches,
handles auth, vault selection, and local file sync — but ingestion, semantic
search, and chat fail once a vault has files.

### First-run auth

There's no session on a fresh machine, so the app opens to the Google OAuth
sign-in screen. OAuth runs through a local callback server that tries ports
`47155`, `47156`, `47157` in order (first one that binds wins) — kept below
Windows' dynamic port range (49152-65535), where Hyper-V/WSL2/Docker can
reserve blocks that no process may bind. The server binds `127.0.0.1`
specifically (never `localhost`, which can resolve to `::1` ahead of
`127.0.0.1` and silently miss an IPv4-only listener). **Every one of these
exact URLs** must be added to Supabase under Authentication → URL
Configuration → Redirect URLs:

- `http://127.0.0.1:47155/callback`
- `http://127.0.0.1:47156/callback`
- `http://127.0.0.1:47157/callback`

If a URL isn't in that allowlist, Supabase's `/authorize` endpoint silently
ignores the `redirect_to` we sent and falls back to the project's
**Site URL** instead — which, if it still points at an old/different
callback address, sends the browser to a port nothing is listening on
after Google auth has already succeeded, surfacing as
`ERR_CONNECTION_REFUSED` with the access token sitting unusable in the URL
fragment. If that happens, check Authentication → URL Configuration → Site
URL in the Supabase dashboard and either update it to match one of the
ports above or add all three to the Redirect URLs allowlist.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture, data
  flow diagrams, current component layout, and the restructuring plan/decision
  log.
- [`CLAUDE.md`](CLAUDE.md) — repo layout and instructions for AI coding
  agents working in this codebase.
