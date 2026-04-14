"""
Duckietown AI Sidecar
FastAPI server exposing ingestion and semantic search/chat endpoints.
Spawned as a subprocess by the Go backend on app launch.
"""

import os
import sys

# Suppress ChromaDB telemetry — must happen before any chromadb import
os.environ["ANONYMIZED_TELEMETRY"] = "False"
os.environ["CHROMA_TELEMETRY"] = "False"

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Add sidecar dir to path (needed when running as PyInstaller bundle)
if getattr(sys, "frozen", False):
    BASE_DIR = sys._MEIPASS  # type: ignore
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, BASE_DIR)

from ingest import router as ingest_router
from search import router as search_router

app = FastAPI(title="Duckietown Sidecar", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest_router, prefix="/ingest")
app.include_router(search_router, prefix="/search")


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    port = int(os.environ.get("SIDECAR_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
