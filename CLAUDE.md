# Duckietown

Smart AI-based vectorized cloud file system. Desktop app (Wails v2 + Go) with a
React/TypeScript frontend, backed by Supabase (Postgres + Storage) and a Python
FastAPI sidecar that handles embeddings, OCR-less content extraction, and RAG chat.

See `README.md` for the project pitch and `TECHNICAL_IMPLEMENTATION.md` for the
full architecture writeup (components, data flow, event names, etc.).

## Layout

- `duckietown/` — the actual app (Go backend + `frontend/` React app + `sidecar/` Python service). This is the Wails project root (`wails.json`, `go.mod` live here).
- `duckietown/sidecar/` — FastAPI service (ingest, search, chat). Has its own `.venv/`. `sidecar/rename.py` is the AI-rename flow (search → propose names → plan) — mirrors `organise.py`'s shape.
- `duckietown/frontend/` — Vite + React + TypeScript + shadcn/ui.
- `duckietown/internal/shell/` — Windows-only Explorer integration (custom vault folder icon + a pinned "Duckietown" nav-pane entry), HKCU-only, no admin rights, no-op on other OSes (`//go:build` split).

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

`sidecar.Start()` (`internal/sidecar/process.go`) always kills whatever's
listening on port 8000 before spawning a fresh sidecar, so a normal
`wails dev` restart is self-cleaning — no manual process kill needed in
the common case. The exception is a sidecar left over from manual
testing/debugging on a *different* port (e.g. `SIDECAR_PORT` overridden
by hand), or a process that's hung without binding anything — those won't
be on 8000, so `Start()` won't touch them. To check for stragglers:

```
tasklist /FI "IMAGENAME eq python.exe"
netstat -ano | findstr :8000
```
Any `python.exe main.py` from `duckietown/sidecar/.venv/Scripts/` is a
sidecar instance; `taskkill /F /PID <pid>` to clear one out.

## Environment variables

Config lives in `duckietown/.env` and/or `duckietown/.env.local` (both
gitignored; `.env.local` wins when both define a key — see `NewApp()` in
`app.go`). `duckietown/.env.example` documents the names with no values.

| Variable | Required for | Notes |
|---|---|---|
| `SUPABASE_URL` | everything (auth, storage, db) | Supabase project URL |
| `SUPABASE_KEY` | everything | Supabase publishable/anon key |
| `OPENROUTER_API_KEY` | AI chat, image captioning, file-profile enrichment, organise intent/judging | sidecar-only, forwarded by `sidecar.go` |
| `CHAT_MODEL` | AI chat (tool calling: `search_files`/`read_file`/`propose_reorganisation`/`propose_rename`) | optional, defaults to `anthropic/claude-haiku-5.5`; `OPENROUTER_MODEL` is a deprecated alias |
| `INTENT_MODEL` | organise: intent parsing + candidate judging; rename: intent parsing + name proposals | optional, defaults to `anthropic/claude-haiku-5.5` |
| `CAPTION_MODEL` | image captioning at ingest time | optional, defaults to `anthropic/claude-haiku-5.5` |
| `ENRICH_MODEL` | ingest-time file-profile generation (summary/category/keywords) | optional, defaults to `anthropic/claude-haiku-5.5` |
| `JINA_API_KEY` | embeddings (ingest + semantic search) | sidecar-only, read directly from process env by `ingest.py`/`retrieval.py` |

Without `OPENROUTER_API_KEY`/`JINA_API_KEY`, the app still builds, launches,
handles auth, vault selection, and local file sync — but ingestion, semantic
search, and chat will fail once a vault has files, since the sidecar's calls
to Jina/OpenRouter will error out.

## First-run auth note

There is no session on a fresh machine (`%AppData%/duckietown/session.json`
is absent), so the app opens to the Google OAuth sign-in screen. OAuth runs
through a local callback server that tries ports `47155`, `47156`, `47157`
in order (first one that binds wins) — chosen below Windows' dynamic port
range (49152-65535), where Hyper-V/WSL2/Docker can reserve blocks that no
process may bind. The server binds `127.0.0.1` explicitly, never
`localhost` (which can resolve to `::1` and miss an IPv4-only listener).
**Every one of these exact URLs** must be registered in Supabase under
Authentication → URL Configuration → Redirect URLs — and the Site URL
there must point at one of them too, since Supabase silently falls back to
the Site URL (not an error) whenever `redirect_to` isn't in the allowlist:
`http://127.0.0.1:47155/callback`, `http://127.0.0.1:47156/callback`, and
`http://127.0.0.1:47157/callback`. See README.md's "First-run auth"
section for the full failure mode this causes if misconfigured.

## Windows Explorer integration (dev cleanup)

`internal/shell` applies a custom vault folder icon (`desktop.ini` +
attributes) and a pinned nav-pane entry (HKCU registry only, no admin
rights). The app's own `RemoveExplorerIntegration()` / the sidebar's
"Show in File Explorer" toggle undo this normally — use these only if you
need to clean up by hand (e.g. after deleting a dev vault folder
out-of-band):

```
HKCU\Software\Classes\CLSID\{06EFE274-766E-42D6-B205-32B17E9A442B}                                            — delete entire subtree
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\{06EFE274-766E-42D6-B205-32B17E9A442B} — delete key
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel                        — delete ONLY the {06EFE274-766E-42D6-B205-32B17E9A442B} value, not the key (other apps' entries live there too)
```

Also by hand if needed: delete `<vault>\desktop.ini` and
`<vault>\.duckietown-desktop-ini.bak`, `attrib -r "<vault>"` to clear the
read-only attribute, and optionally delete
`%LOCALAPPDATA%\Duckietown\icons\duckietown-folder.ico`. See
`docs/ARCHITECTURE.md`'s Explorer integration section for the full
design.
