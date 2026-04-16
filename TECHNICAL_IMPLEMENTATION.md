# Duckietown - Technical Implementation Documentation

## Table of Contents
1. [System Architecture Overview](#system-architecture-overview)
2. [Technology Stack](#technology-stack)
3. [Core Components](#core-components)
4. [NLP Pipeline & Embedding Generation](#nlp-pipeline--embedding-generation)
5. [Ingestion Workflow (End-to-End)](#ingestion-workflow-end-to-end)
6. [AI Chat Implementation](#ai-chat-implementation)
7. [Data Flow Diagrams](#data-flow-diagrams)
8. [File System Monitoring](#file-system-monitoring)
9. [Authentication & Session Management](#authentication--session-management)
10. [Database Operations](#database-operations)
11. [Frontend Architecture](#frontend-architecture)

---

## System Architecture Overview

Duckietown is a **Smart AI-Based Vectorized Cloud File System** that combines local file system monitoring with cloud storage and AI-powered semantic search. The system follows a **sidecar architecture** where a Go backend orchestrates operations while a Python FastAPI sidecar handles AI/ML workloads.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Desktop Application                         │
│                    (Wails v2 + Go Backend)                        │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ├── File System (fsnotify)
                     │   └── Monitors vault directory
                     │
                     ├── Supabase Client
                     │   ├── PostgreSQL (file metadata)
                     │   └── Storage (file blobs)
                     │
                     └── HTTP Client
                         └── Communicates with Python Sidecar
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Python Sidecar (FastAPI)                      │
│                    localhost:8000                                 │
├─────────────────────────────────────────────────────────────────┤
│  • /ingest/file    - File ingestion & embedding                 │
│  • /ingest/move    - Update metadata on rename/move              │
│  • /ingest/delete  - Remove embeddings                           │
│  • /search/query   - Semantic search                             │
│  • /search/chat    - RAG chat with streaming                     │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ├── ChromaDB (Vector Database)
                     │   └── Local persistent storage
                     │
                     ├── Jina AI API
                     │   └── CLIP v2 embeddings
                     │
                     └── OpenRouter API
                         └── Gemma LLM for chat & captioning
```

---

## Technology Stack

### Backend (Go)
- **Framework**: Wails v2 (desktop application framework)
- **File Monitoring**: fsnotify (cross-platform file system watcher)
- **HTTP Client**: net/http with custom HTTP/1.1 transport
- **Configuration**: godotenv for environment variables

### AI/ML Sidecar (Python)
- **Web Framework**: FastAPI with uvicorn
- **Vector Database**: ChromaDB (persistent local storage)
- **Embedding Model**: Jina CLIP v2 via Jina AI API
- **LLM**: Google Gemma 3 via OpenRouter API
- **Content Extraction**: 
  - pdfplumber (PDFs)
  - python-docx (Word documents)
  - openpyxl (Excel spreadsheets)
  - csv (CSV files)

### Frontend (React + TypeScript)
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **UI Library**: shadcn/ui components
- **Styling**: TailwindCSS
- **State Management**: React hooks (useState, useEffect, useCallback)
- **Notifications**: Sonner toast library

### Cloud Infrastructure
- **Database**: Supabase PostgreSQL
- **Storage**: Supabase Storage (S3-compatible)
- **Authentication**: Supabase Auth (OAuth with Google)

---

## Core Components

### 1. Go Backend (`duckietown/`)

#### `app.go` - Core Application Structure
```go
type App struct {
    ctx         context.Context
    vaultPath   string
    isWatching  bool
    watcherStop chan struct{}
    mu          sync.Mutex
    
    supaURL string
    supaKey string
    
    userID       string
    accessToken  string
    refreshToken string
    email        string
}
```

**Responsibilities**:
- Application lifecycle management (startup/shutdown)
- Session restoration and authentication state
- Vault path configuration
- Coordinates between file watcher, sidecar, and ingest worker
- Emits Wails events to frontend

**Key Functions**:
- `startup()`: Initializes session, starts sidecar, watcher, and ingest worker
- `shutdown()`: Cleanly stops sidecar process

#### `files.go` - File Operations & Ingest Queue
```go
var ingestQueue = make(chan ingestJob, 64)

type ingestJob struct {
    filePath string
    fileName string
}
```

**Responsibilities**:
- File CRUD operations (List, Delete, Rename, Open)
- Ingest queue management (serialized processing)
- Full synchronization between local, Supabase, and ChromaDB
- File upload to Supabase Storage
- Metadata management in Supabase PostgreSQL

**Key Functions**:
- `startIngestWorker()`: Serializes file ingestion to respect rate limits
- `queueIngest()`: Adds files to ingest queue with backpressure handling
- `fullSync()`: Three-way sync between local filesystem, Supabase, and ChromaDB
- `DeleteFile()`: Cascading delete (local + storage + database + embeddings)
- `RenameFile()`: Updates metadata without re-embedding

#### `ingest.go` - Sidecar Communication
```go
const sidecarBase = "http://127.0.0.1:8000"
```

**Responsibilities**:
- HTTP client for Python sidecar communication
- Health checks for sidecar availability
- Ingest request orchestration
- Embedding management (move, delete, list indexed)

**Key Functions**:
- `IngestFile()`: Sends file to sidecar for embedding
- `GetIndexedFiles()`: Retrieves list of files in ChromaDB
- `MoveFileEmbeddings()`: Updates metadata on rename/move (no re-embed)
- `DeleteFileEmbeddings()`: Removes embeddings from ChromaDB

#### `agent.go` - AI Search & Chat
```go
type SearchResult struct {
    FileName   string  `json:"file_name"`
    Similarity float64 `json:"similarity"`
    Snippet    string  `json:"snippet"`
    Modality   string  `json:"modality"`
    Page       string  `json:"page"`
}
```

**Responsibilities**:
- Semantic search via sidecar
- Streaming RAG chat implementation
- AI-powered file organization
- Wails event emission for streaming responses

**Key Functions**:
- `SemanticSearch()`: Query embeddings with top-K retrieval
- `ChatWithAgent()`: Streaming chat with context retrieval
- `OrganiseFolder()`: AI-driven file organization using semantic search

#### `watcher.go` - File System Monitoring
```go
func (a *App) startWatcher() {
    watcher, err := fsnotify.NewWatcher()
    // Walk vault and add all directories recursively
    filepath.WalkDir(a.vaultPath, func(path string, d os.DirEntry, err error) error {
        if d.IsDir() {
            watcher.Add(path)
        }
        return nil
    })
}
```

**Responsibilities**:
- Real-time file system monitoring using fsnotify
- Recursive directory watching
- Event handling (Create, Write, Rename, Remove)
- Automatic upload and ingest on file changes
- Folder creation/deletion tracking

**Event Handling Logic**:
- **Create/Write**: Upload to Supabase, queue for ingest
- **Rename**: Detect move vs delete, update metadata accordingly
- **Remove**: Delete from storage, database, and embeddings
- **Directory events**: Track folder structure changes

#### `sidecar.go` - Python Process Management
```go
func (a *App) startSidecar() error {
    // Kill stale processes on port 8000
    killProcessOnPort(8000)
    
    // Find bundled binary or dev script
    sidecarBin := filepath.Join(exeDir, "sidecar", "duckietown_sidecar", "duckietown_sidecar")
    
    // Set environment variables
    cmd.Env = append(os.Environ(),
        "SIDECAR_PORT=8000",
        "CHROMA_DIR="+chromaDir,
        "OPENROUTER_API_KEY="+os.Getenv("OPENROUTER_API_KEY"),
    )
    
    // Start process and wait for health endpoint
    cmd.Start()
    waitForSidecar("http://127.0.0.1:8000/health", 60)
}
```

**Responsibilities**:
- Python sidecar process lifecycle management
- Port cleanup (kills stale processes)
- Environment variable configuration
- Health check with timeout
- Cross-platform binary/script detection

#### `supabase.go` - Database & Storage Operations
```go
const bucket = "duckietown"

func (a *App) storagePath(fileName, folderPath string) string {
    if folderPath == "" {
        return fmt.Sprintf("%s/%s", a.userID, fileName)
    }
    return fmt.Sprintf("%s/%s/%s", a.userID, folderPath, fileName)
}
```

**Responsibilities**:
- File upload/download to Supabase Storage
- PostgreSQL CRUD operations via REST API
- Metadata management (files table)
- Signed URL generation for file access
- Storage listing and cleanup

**Key Functions**:
- `supaUploadFile()`: Upload file with upsert semantics
- `supaUpsertFileRecord()`: Insert/update metadata with conflict resolution
- `supaListFiles()`: Retrieve all files for user
- `supaListStorageFiles()`: List all storage objects recursively
- `supaGetFileURL()`: Generate signed URL for file access

#### `auth.go` - Authentication & Session Management
```go
const callbackPort = 49155
const callbackURL = "http://localhost:49155/callback"
```

**Responsibilities**:
- Google OAuth flow implementation
- Local HTTP server for OAuth callback
- Token management (access + refresh)
- Session persistence
- Automatic token refresh on 401 errors
- HTTP/1.1 transport for compatibility

**OAuth Flow**:
1. Bind local port 49155
2. Open browser with Supabase OAuth URL
3. User authenticates with Google
4. Supabase redirects to localhost callback
5. HTML page extracts tokens from URL fragment
6. Tokens POSTed to `/token` endpoint
7. Session stored and user info fetched

#### `config.go` - Configuration Management
```go
type Config struct {
    VaultPath string `json:"vault_path"`
}

type Session struct {
    AccessToken  string `json:"access_token"`
    RefreshToken string `json:"refresh_token"`
    UserID       string `json:"user_id"`
    Email        string `json:"email"`
}
```

**Responsibilities**:
- User configuration persistence (vault path)
- Session token storage
- Token refresh logic
- File system paths for config directory

#### `folders.go` - Folder Management
```go
type FolderRecord struct {
    Path     string `json:"path"`
    Name     string `json:"name"`
    Parent   string `json:"parent"`
    Children int    `json:"children"`
}
```

**Responsibilities**:
- Folder hierarchy management
- Folder creation/deletion
- File movement between folders
- Recursive folder operations
- Child count calculation

#### `mime.go` - MIME Type Detection
```go
func getMimeType(fileName string) string {
    mime.AddExtensionType(".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    mime.AddExtensionType(".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    // ... more extensions
}
```

**Responsibilities**:
- MIME type detection for file uploads
- Cross-platform file opening with system default
- Extension-to-MIME mapping

### 2. Python Sidecar (`duckietown/sidecar/`)

#### `main.py` - FastAPI Server
```python
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
```

**Responsibilities**:
- FastAPI application setup
- CORS middleware configuration
- Router inclusion (ingest, search)
- Health check endpoint
- ChromaDB telemetry suppression

#### `extract.py` - Multimodal Content Extraction
```python
CHUNK_SIZE = 500
CHUNK_OVERLAP = 100

def _chunk_text(text: str) -> List[str]:
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks
```

**Responsibilities**:
- Content extraction from various file types
- Text chunking with overlap
- Modality detection (text, image, audio, video)
- File type routing

**Supported File Types**:
- **PDF**: `pdfplumber` - extracts text per page
- **DOCX**: `python-docx` - extracts paragraphs
- **XLSX**: `openpyxl` - extracts spreadsheet rows
- **CSV**: Built-in csv reader
- **Text files**: Direct reading with UTF-8 handling
- **Images**: Returns file path for captioning
- **Audio/Video**: Returns metadata stub
- **Other**: Generic file metadata

**Chunking Strategy**:
- Fixed chunk size: 500 characters
- Overlap: 100 characters (20% overlap)
- Ensures context continuity across chunks
- Preserves page numbers for PDFs

#### `ingest.py` - Ingestion Pipeline
```python
JINA_API_KEY = os.environ.get("JINA_API_KEY", "")
JINA_CLIP_URL = "https://api.jina.ai/v1/embeddings"
JINA_CLIP_MODEL = "jina-clip-v2"

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
CAPTION_MODEL = "google/gemma-3-12b-it"

JINA_BATCH_SIZE = 8
CHROMA_BATCH_SIZE = 100
MAX_RETRIES = 5
RETRY_BASE_DELAY = 2.0
```

**Responsibilities**:
- Image captioning via OpenRouter API
- Text embedding via Jina CLIP v2
- ChromaDB upsert operations
- Metadata management
- Batch processing with rate limit handling
- Embedding move/delete operations

**Key Functions**:

**Image Captioning**:
```python
def _caption_image(file_path: str, file_name: str) -> str:
    b64 = _image_to_base64(file_path)
    resp = requests.post(
        OPENROUTER_URL,
        json={
            "model": CAPTION_MODEL,
            "max_tokens": 300,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": b64}},
                    {"type": "text", "text": "Describe this image in detail..."}
                ]
            }]
        }
    )
    return resp.json()["choices"][0]["message"]["content"]
```

**Embedding Generation**:
```python
def _embed_batch_with_retry(chunks: List[Dict[str, Any]]) -> List[List[float]]:
    for attempt in range(1, MAX_RETRIES + 1):
        resp = requests.post(JINA_CLIP_URL, json=payload)
        if resp.status_code == 429:
            wait = max(int(resp.headers.get("Retry-After", delay)), delay)
            time.sleep(wait)
            delay *= 2
            continue
        resp.raise_for_status()
        return [item["embedding"] for item in resp.json()["data"]]
```

**Ingestion Endpoint**:
```python
@router.post("/file")
def ingest_file(req: IngestRequest):
    chunks = extract(req.file_path)
    chunks = _prepare_chunks(chunks, req.file_name)  # Caption images
    embeddings = _embed_chunks(chunks, req.file_name)
    
    collection = _get_collection(req.user_id)
    collection.upsert(
        ids=ids,
        embeddings=embeddings,
        documents=docs,
        metadatas=metadatas
    )
```

**Rate Limit Handling**:
- Exponential backoff (2s, 4s, 8s, 16s, 32s)
- Respects Jina API Retry-After header
- Batch size of 8 chunks per request
- 0.5s delay between batches

**Metadata Structure**:
```python
{
    "file_name": "document.pdf",
    "chunk_index": 0,
    "modality": "text",  # or "image", "audio", "video"
    "page": "1"  # for PDFs
}
```

#### `search.py` - Semantic Search & RAG Chat
```python
SIMILARITY_THRESHOLD = 0.7
TOP_K_DEFAULT = 50
TOP_FALLBACK = 3

TYPE_KEYWORDS = {
    "image": "image", "photo": "image",
    "pdf": "text", "document": "text",
    "audio": "audio", "video": "video"
}
```

**Responsibilities**:
- Semantic search with similarity scoring
- Type-aware filtering (images, PDFs, etc.)
- RAG (Retrieval-Augmented Generation) chat
- Streaming response via Server-Sent Events
- Context retrieval from ChromaDB

**Semantic Search**:
```python
@router.post("/query")
def semantic_query(req: QueryRequest):
    query_emb = _embed_query(req.query)
    results = collection.query(
        query_embeddings=[query_emb],
        n_results=n,
        include=["documents", "metadatas", "distances"]
    )
    
    # Convert distance to similarity (cosine)
    similarity = max(0.0, 1.0 - dist / 2.0)
    
    # Deduplicate by file name
    # Keep best score per file
    # Apply type filter if requested
    # Return files >= 0.7 similarity, or top 3 fallback
```

**Similarity Calculation**:
- ChromaDB returns cosine distance (0-2)
- Convert to similarity: `1.0 - distance / 2.0`
- Threshold: 0.7 (high similarity)
- Fallback: top 3 results if none meet threshold

**Type-Aware Filtering**:
```python
def _detect_type_filter(query: str) -> Optional[str]:
    words = re.findall(r"\w+", query.lower())
    for word in words:
        if word in TYPE_KEYWORDS:
            return TYPE_KEYWORDS[word]
    return None
```

**RAG Chat Implementation**:
```python
@router.post("/chat")
async def chat(req: ChatRequest):
    # Retrieve context
    if req.file_name:
        # Get all chunks for specific file
        file_chunks = collection.get(where={"file_name": req.file_name})
    else:
        # Semantic retrieval for general questions
        query_emb = _embed_query(req.message)
        results = collection.query(query_embeddings=[query_emb])
    
    # Build system prompt with context
    system_prompt = f"You are Duckietown AI... FILE CONTENT:\n{context_text}"
    
    # Stream response via SSE
    async def event_stream():
        yield sources
        async with httpx.AsyncClient() as client:
            async for line in response.aiter_lines():
                yield token
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")
```

**Streaming Format**:
```
data: {"type": "sources", "files": [{"file_name": "doc.pdf", "similarity": 0.85}]}

data: {"type": "token", "content": "Based"}

data: {"type": "token", "content": " on"}

data: [DONE]
```

### 3. Frontend (`duckietown/frontend/`)

#### `App.tsx` - Main Application Component
```typescript
type Screen = "loading" | "auth" | "setup" | "main";

interface User {
  user_id: string;
  email: string;
}
```

**Responsibilities**:
- Screen state management (auth, setup, main)
- User authentication state
- File list management
- Wails event listeners
- Toast notifications

**Wails Events**:
- `auth-success`: User signed in successfully
- `auth-error`: Authentication failed
- `auth-restored`: Session restored from disk
- `auth-expired`: Session expired, re-auth required
- `file-uploaded`: File synced to cloud
- `file-changed`: File modified, syncing in progress
- `upload-error`: Upload failed
- `watcher-ready`: File system watcher active

**Screen Flow**:
1. **Loading**: Check for existing session
2. **Auth**: Google OAuth sign-in
3. **Setup**: Select vault folder
4. **Main**: File browser, search, chat

---

## NLP Pipeline & Embedding Generation

### Overview

The NLP pipeline transforms raw files into searchable vector embeddings through a multi-stage process:

```
Raw File → Content Extraction → Chunking → Image Captioning → Embedding → ChromaDB
```

### Stage 1: Content Extraction (`extract.py`)

**File Type Detection**:
```python
mime, _ = mimetypes.guess_type(path)
ext = Path(path).suffix.lower()
```

**Extraction Strategies**:

**PDF Documents**:
```python
def extract_pdf(path: str) -> List[Dict[str, Any]]:
    with pdfplumber.open(path) as pdf:
        for page_num, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            for chunk in _chunk_text(text):
                chunks.append({
                    "text": chunk,
                    "chunk_index": len(chunks),
                    "modality": "text",
                    "page": page_num + 1
                })
```
- Extracts text page-by-page
- Preserves page numbers in metadata
- Chunks each page's text

**Word Documents**:
```python
def extract_docx(path: str) -> List[Dict[str, Any]]:
    doc = Document(path)
    full_text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    return [{"text": c, "chunk_index": i, "modality": "text"} 
            for i, c in enumerate(_chunk_text(full_text))]
```
- Extracts all paragraphs
- Concatenates with newlines
- Chunks the full text

**Excel Spreadsheets**:
```python
def extract_xlsx(path: str) -> List[Dict[str, Any]]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for sheet in wb.worksheets:
        for row in sheet.iter_rows(values_only=True):
            row_text = " | ".join(str(c) for c in row if c is not None)
            rows.append(row_text)
```
- Reads all sheets
- Converts rows to pipe-separated text
- Preserves tabular structure

**Images**:
```python
def extract_image(path: str) -> List[Dict[str, Any]]:
    return [{
        "text": f"Image: {name}",
        "chunk_index": 0,
        "modality": "image",
        "file_path": path  # Path for captioning
    }]
```
- Returns file path instead of text
- Modality set to "image"
- Text stub as fallback

### Stage 2: Text Chunking

**Algorithm**:
```python
CHUNK_SIZE = 500
CHUNK_OVERLAP = 100

def _chunk_text(text: str) -> List[str]:
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks
```

**Characteristics**:
- Fixed-size chunks (500 characters)
- 20% overlap (100 characters)
- Preserves context across boundaries
- Enables semantic continuity

**Example**:
```
Original: "The quick brown fox jumps over the lazy dog. The fox was very fast."
Chunk 1: "The quick brown fox jumps over the lazy dog. The fox was"
Chunk 2: "lazy dog. The fox was very fast."
```

### Stage 3: Image Captioning

**Purpose**: Convert images to searchable text descriptions

**Model**: Google Gemma 3-12B-IT via OpenRouter API

**Prompt Engineering**:
```python
prompt = (
    "Describe this image in detail for search indexing. "
    "Include: number of people and their appearance, objects, "
    "setting/location, colors, actions, text visible, mood. "
    "Be specific and thorough. Reply with description only, no preamble."
)
```

**Process**:
1. Convert image to base64
2. Send to OpenRouter with image_url content type
3. Receive detailed description (max 300 tokens)
4. Replace image stub with caption

**Example Output**:
```
"A photo of three people sitting at a wooden table in a coffee shop. 
Two women are wearing glasses, one man has a beard. Warm lighting, 
brown and orange tones. They are looking at a laptop screen together."
```

### Stage 4: Embedding Generation

**Model**: Jina CLIP v2 via Jina AI API

**Capabilities**:
- Multimodal (text + image + audio)
- 1024-dimensional vectors
- Cosine similarity
- Normalized embeddings

**Batch Processing**:
```python
JINA_BATCH_SIZE = 8

def _embed_chunks(chunks: List[Dict[str, Any]]) -> List[List[float]]:
    for i in range(0, len(chunks), JINA_BATCH_SIZE):
        batch_embs = _embed_batch_with_retry(chunks[i:i+JINA_BATCH_SIZE])
        all_embeddings.extend(batch_embs)
        time.sleep(0.5)  # Rate limit protection
```

**Rate Limit Handling**:
```python
for attempt in range(1, MAX_RETRIES + 1):
    resp = requests.post(JINA_CLIP_URL, json=payload)
    if resp.status_code == 429:
        wait = max(int(resp.headers.get("Retry-After", delay)), delay)
        time.sleep(wait)
        delay *= 2  # Exponential backoff
        continue
```

**Retry Strategy**:
- Max 5 retries
- Base delay: 2 seconds
- Exponential backoff: 2s, 4s, 8s, 16s, 32s
- Respects Retry-After header

**Embedding Format**:
```python
{
    "model": "jina-clip-v2",
    "input": [{"text": "chunk content"}],
    "normalized": True
}
```

### Stage 5: ChromaDB Storage

**Collection Structure**:
```python
def _get_collection(user_id: str) -> chromadb.Collection:
    safe_id = "user_" + user_id.replace("-", "_")
    return _chroma_client.get_or_create_collection(
        name=safe_id,
        metadata={"hnsw:space": "cosine"}
    )
```

**User Isolation**:
- Separate collection per user
- Collection name: `user_<user_id>`
- HNSW index with cosine similarity

**Upsert Operation**:
```python
collection.upsert(
    ids=ids,  # MD5 hash of "filename::chunk_index"
    embeddings=embeddings,  # List of 1024-dim vectors
    documents=docs,  # Original text chunks
    metadatas=metadatas  # {file_name, chunk_index, modality, page}
)
```

**Batch Size**:
- 100 chunks per upsert
- Balances memory and performance
- Reduces API calls to ChromaDB

**Metadata Schema**:
```python
{
    "file_name": "document.pdf",
    "chunk_index": 5,
    "modality": "text",
    "page": "2"
}
```

---

## Ingestion Workflow (End-to-End)

### Trigger Points

**1. File System Watcher (Automatic)**
```
File Created/Modified → fsnotify Event → handleFSEvent() → queueIngest()
```

**2. Full Sync (Manual/Startup)**
```
App Startup → fullSync() → Check Indexed Files → queueIngest() for new files
```

**3. Manual Upload**
```
User drops file → Watcher detects → queueIngest()
```

### Detailed Workflow

#### Step 1: File Detection
```go
// watcher.go
case event.Has(fsnotify.Create), event.Has(fsnotify.Write):
    wailsruntime.EventsEmit(a.ctx, "file-changed", map[string]string{
        "event_type": "created",
        "file_name":  name,
        "path":       event.Name,
        "folder":     folderPath,
    })
    time.Sleep(200 * time.Millisecond)  // Debounce
    go func() {
        a.supaUploadFile(event.Name, name, folderPath)
        wailsruntime.EventsEmit(a.ctx, "file-uploaded", name)
        queueIngest(event.Name, name)  // Add to queue
    }()
```

**Debouncing**: 200ms delay to handle rapid writes

#### Step 2: Queue Processing
```go
// files.go
func (a *App) startIngestWorker() {
    go func() {
        for job := range ingestQueue {
            if err := a.IngestFile(job.filePath, job.fileName); err != nil {
                fmt.Printf("⚠️ Ingest failed for %s: %v\n", job.fileName, err)
            } else {
                fmt.Printf("🧠 Ingested: %s\n", job.fileName)
            }
        }
    }()
}
```

**Serialization**: One file at a time to respect Jina rate limits

#### Step 3: Sidecar Request
```go
// ingest.go
func (a *App) IngestFile(filePath, fileName string) error {
    body, _ := json.Marshal(ingestRequest{
        FilePath: filePath,
        FileName: fileName,
        UserID:   a.userID,
    })
    
    client := &http.Client{Timeout: 120 * time.Second}
    resp, err := client.Post(sidecarBase+"/ingest/file", "application/json", bytes.NewReader(body))
    // ... handle response
}
```

**Timeout**: 120 seconds for large files

#### Step 4: Content Extraction
```python
# ingest.py
@router.post("/file")
def ingest_file(req: IngestRequest):
    chunks = extract(req.file_path)  # extract.py
    if not chunks:
        return {"status": "skipped", "detail": "no extractable content"}
```

**Extraction Routing**:
- PDF → `extract_pdf()`
- DOCX → `extract_docx()`
- XLSX → `extract_xlsx()`
- Image → `extract_image()`
- Text → `extract_text()`

#### Step 5: Image Captioning (if applicable)
```python
# ingest.py
chunks = _prepare_chunks(chunks, req.file_name)

def _prepare_chunks(chunks: List[Dict[str, Any]], file_name: str) -> List[Dict[str, Any]]:
    prepared = []
    for chunk in chunks:
        if chunk.get("modality") == "image" and chunk.get("file_path"):
            caption = _caption_image(chunk["file_path"], file_name)
            prepared.append({**chunk, "text": caption})
        else:
            prepared.append(chunk)
    return prepared
```

**Captioning**: Only for image modality chunks

#### Step 6: Embedding Generation
```python
# ingest.py
embeddings = _embed_chunks(chunks, req.file_name)

def _embed_chunks(chunks: List[Dict[str, Any]], file_name: str) -> List[List[float]]:
    all_embeddings = []
    total_batches = -(-len(chunks) // JINA_BATCH_SIZE)
    for i in range(0, len(chunks), JINA_BATCH_SIZE):
        print(f"[ingest] {file_name}: batch {i // JINA_BATCH_SIZE + 1}/{total_batches}")
        batch_embs = _embed_batch_with_retry(chunks[i : i + JINA_BATCH_SIZE])
        all_embeddings.extend(batch_embs)
        if i + JINA_BATCH_SIZE < len(chunks):
            time.sleep(0.5)
    return all_embeddings
```

**Batch Processing**: 8 chunks per batch with 0.5s delay

#### Step 7: ChromaDB Storage
```python
# ingest.py
collection = _get_collection(req.user_id)
ids = [_chunk_id(req.file_name, c["chunk_index"]) for c in chunks]
docs = [c["text"] for c in chunks]
metadatas = [{
    "file_name": req.file_name,
    "chunk_index": c["chunk_index"],
    "modality": c.get("modality", "text"),
    "page": str(c.get("page") or ""),
} for c in chunks]

for i in range(0, len(ids), CHROMA_BATCH_SIZE):
    collection.upsert(
        ids=ids[i : i + CHROMA_BATCH_SIZE],
        embeddings=embeddings[i : i + CHROMA_BATCH_SIZE],
        documents=docs[i : i + CHROMA_BATCH_SIZE],
        metadatas=metadatas[i : i + CHROMA_BATCH_SIZE],
    )
```

**Batch Upsert**: 100 chunks per operation

#### Step 8: Response
```python
# ingest.py
print(f"[ingest] ✅ {req.file_name}: {len(chunks)} chunks stored")
return {"status": "ok", "chunks": len(chunks), "file": req.file_name}
```

**Success**: Return chunk count for logging

### Error Handling

**Extraction Failures**:
```python
# extract.py
try:
    # extraction logic
except Exception as e:
    print(f"[extract] Error on {path}: {e}")
    return [{"text": f"File: {name}", "modality": "other"}]
```

**Embedding Failures**:
```python
# ingest.py
except Exception as e:
    print(f"[ingest] Error ingesting {req.file_name}: {e}")
    return {"status": "error", "detail": str(e)}
```

**Sidecar Unavailable**:
```go
// ingest.go
if !sidecarReady() {
    fmt.Printf("⚠️ Sidecar not ready, skipping ingest for %s\n", fileName)
    return nil
}
```

### Performance Characteristics

**Typical Processing Times**:
- Text file (1KB): 1-2 seconds
- PDF (10 pages): 5-10 seconds
- Image with captioning: 3-5 seconds
- Large PDF (100 pages): 30-60 seconds

**Bottlenecks**:
1. Jina API rate limits (primary)
2. Image captioning via OpenRouter
3. PDF text extraction
4. Network latency

---

## AI Chat Implementation

### Architecture

The AI chat uses **Retrieval-Augmented Generation (RAG)** to provide context-aware responses grounded in user files.

```
User Query → Context Retrieval → Prompt Construction → LLM Streaming → Response
```

### Components

#### 1. Context Retrieval

**File-Specific Context**:
```python
# search.py
if req.file_name:
    file_chunks = collection.get(
        where={"file_name": req.file_name},
        include=["documents"],
    )
    if file_chunks["documents"]:
        context_text = "\n\n".join(file_chunks["documents"][:20])
        source_files = [{"file_name": req.file_name, "similarity": 1.0}]
```

**Semantic Retrieval**:
```python
# search.py
else:
    query_emb = _embed_query(req.message)
    results = collection.query(
        query_embeddings=[query_emb],
        n_results=min(8, count),
        include=["documents", "metadatas", "distances"],
    )
    
    chunks = []
    seen_files = set()
    for doc, meta, dist in zip(results["documents"][0], results["metadatas"][0], results["distances"][0]):
        sim = max(0.0, 1.0 - dist / 2.0)
        if sim > 0.3:  # Similarity threshold
            fname = meta["file_name"]
            page = f" (page {meta['page']})" if meta.get("page") else ""
            chunks.append(f"[{fname}{page}]\n{doc}")
            if fname not in seen_files:
                source_files.append({"file_name": fname, "similarity": round(sim, 4)})
                seen_files.add(fname)
    context_text = "\n\n---\n\n".join(chunks)
```

**Retrieval Strategy**:
- Top 8 chunks by similarity
- Minimum similarity: 0.3
- Deduplicate by file name
- Include page numbers for PDFs
- Format: `[filename (page)]\ncontent`

#### 2. Prompt Construction

**System Prompt**:
```python
system_prompt = (
    "You are Duckietown AI, a helpful assistant for a personal file vault. "
    "Answer questions based on the file content provided. "
    "Be concise and clear. Always cite which file your answer comes from.\n\n"
)
```

**Context Injection**:
```python
if context_text:
    system_prompt += f"FILE CONTENT:\n{context_text}"
else:
    system_prompt += "No relevant file content found for this query."
```

**Message Assembly**:
```python
messages = [{"role": "system", "content": system_prompt}]
for h in req.history or []:
    messages.append({"role": h.role, "content": h.content})
messages.append({"role": "user", "content": req.message})
```

**Conversation History**:
- Maintains context across turns
- Limits to recent history (managed by frontend)
- Enables multi-turn conversations

#### 3. LLM Streaming

**Model**: Google Gemma 3-27B-IT via OpenRouter

**Parameters**:
```python
{
    "model": CHAT_MODEL,
    "messages": messages,
    "stream": True,
    "max_tokens": 1024,
    "temperature": 0.3
}
```

**Temperature**: 0.3 (focused, less random)

#### 4. Server-Sent Events (SSE)

**Streaming Format**:
```python
async def event_stream():
    # First, send sources
    yield f"data: {json.dumps({'type': 'sources', 'files': source_files})}\n\n"
    
    # Then, stream tokens
    async with httpx.AsyncClient(timeout=60.0) as client:
        async with client.stream("POST", OPENROUTER_URL, json=payload) as response:
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    yield "data: [DONE]\n\n"
                    return
                chunk = json.loads(raw)
                delta = chunk["choices"][0]["delta"].get("content", "")
                if delta:
                    yield f"data: {json.dumps({'type': 'token', 'content': delta})}\n\n"
    
    yield "data: [DONE]\n\n"

return StreamingResponse(event_stream(), media_type="text/event-stream")
```

**Event Types**:
- `sources`: List of files used as context
- `token`: Individual text token
- `[DONE]`: Stream completion

#### 5. Frontend Streaming Handler

**Go Backend (agent.go)**:
```go
func (a *App) ChatWithAgent(message string, history []ChatMessage, fileName string) {
    go func() {
        client := &http.Client{Timeout: 120 * time.Second}
        resp, err := client.Post(sidecarBase+"/search/chat", "application/json", bytes.NewReader(body))
        
        reader := bufio.NewReader(resp.Body)
        for {
            line, err := reader.ReadString('\n')
            if err == io.EOF:
                break
            }
            line = strings.TrimSpace(line)
            if !strings.HasPrefix(line, "data:") {
                continue
            }
            raw := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
            if raw == "[DONE]" {
                wailsruntime.EventsEmit(a.ctx, "chat-done", nil)
                return
            }
            var event map[string]interface{}
            json.Unmarshal([]byte(raw), &event)
            switch event["type"] {
            case "token":
                wailsruntime.EventsEmit(a.ctx, "chat-token", map[string]string{
                    "content": event["content"].(string),
                })
            case "sources":
                wailsruntime.EventsEmit(a.ctx, "chat-sources", event["files"])
            }
        }
    }()
}
```

**Event Emission**:
- `chat-token`: Individual tokens for streaming display
- `chat-sources`: Source files for citation
- `chat-done`: Stream completion
- `chat-error`: Error handling

### Example Chat Flow

**User Query**: "What does the invoice say about the payment terms?"

**Context Retrieved**:
```
[invoice.pdf (page 1)]
Net 30 payment terms. Payment due within 30 days of invoice date.
Late payments subject to 2% monthly fee.

[invoice.pdf (page 2)]
Payment methods: Bank transfer, Credit card, PayPal.
Account number: 123456789
```

**System Prompt**:
```
You are Duckietown AI, a helpful assistant for a personal file vault. 
Answer questions based on the file content provided. 
Be concise and clear. Always cite which file your answer comes from.

FILE CONTENT:
[invoice.pdf (page 1)]
Net 30 payment terms. Payment due within 30 days of invoice date.
Late payments subject to 2% monthly fee.

[invoice.pdf (page 2)]
Payment methods: Bank transfer, Credit card, PayPal.
Account number: 123456789
```

**LLM Response** (streamed):
```
According to invoice.pdf, the payment terms are Net 30, meaning payment is due within 30 days of the invoice date. Late payments incur a 2% monthly fee. Accepted payment methods include bank transfer, credit card, and PayPal.
```

### Performance Optimization

**Context Window**:
- Limit to 20 chunks per file
- Top 8 chunks for semantic retrieval
- Prevents prompt overflow

**Similarity Threshold**:
- 0.3 minimum for retrieval
- Balances relevance and coverage
- Filters noise

**Streaming Benefits**:
- Immediate feedback
- Perceived faster response
- Better UX for long responses

---

## Data Flow Diagrams

### File Upload Flow

```
User drops file
    ↓
fsnotify detects Create event
    ↓
handleFSEvent() emits "file-changed"
    ↓
supaUploadFile() uploads to Supabase Storage
    ↓
supaUpsertFileRecord() saves metadata to PostgreSQL
    ↓
queueIngest() adds to ingest queue
    ↓
IngestWorker processes job
    ↓
IngestFile() calls sidecar /ingest/file
    ↓
extract.py extracts content
    ↓
ingest.py generates embeddings
    ↓
ChromaDB stores vectors
    ↓
emit "file-uploaded"
    ↓
Frontend refreshes file list
```

### Search Flow

```
User enters search query
    ↓
SemanticSearch() calls sidecar /search/query
    ↓
search.py embeds query with Jina CLIP
    ↓
ChromaDB query finds similar chunks
    ↓
Deduplicate by file name
    ↓
Apply similarity threshold (0.7)
    ↓
Return ranked results with snippets
    ↓
Frontend displays results
```

### Chat Flow

```
User sends chat message
    ↓
ChatWithAgent() calls sidecar /search/chat
    ↓
search.py retrieves context (file-specific or semantic)
    ↓
Build system prompt with context
    ↓
Call OpenRouter API with streaming
    ↓
Stream sources event
    ↓
Stream token events
    ↓
Frontend displays streaming response
    ↓
Emit chat-done event
```

---

## File System Monitoring

### fsnotify Integration

**Recursive Watching**:
```go
filepath.WalkDir(a.vaultPath, func(path string, d os.DirEntry, err error) error {
    if err != nil || !d.IsDir() {
        return nil
    }
    if strings.HasPrefix(d.Name(), ".") {
        return filepath.SkipDir
    }
    watcher.Add(path)
    return nil
})
```

**Hidden Directory Exclusion**: Skips directories starting with "."

### Event Types

**Create Event**:
- New file created
- New directory created
- Triggers upload + ingest

**Write Event**:
- File content modified
- Triggers upload + ingest
- Debounced (200ms)

**Rename Event**:
- File moved/renamed
- Triggers move detection logic
- Handles both intra-vault moves and true deletions

**Remove Event**:
- File deleted
- Triggers cascading delete (storage + DB + embeddings)

### Move Detection Logic

```go
case event.Has(fsnotify.Rename):
    time.Sleep(100 * time.Millisecond)
    newPath, newFolder, err := a.findFileInVault(name)
    if err == nil && newPath != "" {
        // File moved within vault
        a.supaDeleteStorageFile(name, folderPath)
        a.supaUploadFile(newPath, name, newFolder)
        a.supaUpdateFileFolderPath(name, newFolder, newSP)
        go a.MoveFileEmbeddings(name, name)
    } else {
        // File truly deleted
        a.supaDeleteStorageFile(name, folderPath)
        a.supaDeleteFileRecord(name)
        go a.DeleteFileEmbeddings(name)
    }
```

**Strategy**:
- Wait 100ms for Create event
- Search vault for file
- If found: move operation
- If not found: delete operation

### File Filtering

**Skipped Files**:
```go
func shouldSkipFile(name string) bool {
    if strings.HasPrefix(name, ".") {
        return true
    }
    skipExts := []string{"~", ".tmp", ".crdownload", ".part", ".partial", ".download"}
    for _, ext := range skipExts {
        if strings.HasSuffix(name, ext) {
            return true
        }
    }
    if strings.HasPrefix(name, "Unconfirmed ") {
        return true
    }
    return false
}
```

**Exclusions**:
- Hidden files (starting with ".")
- Temporary files (various extensions)
- Chrome download temp files

---

## Authentication & Session Management

### OAuth Flow

**1. Initiate Sign-In**:
```go
func (a *App) SignInWithGoogle() error {
    serverReady := make(chan struct{})
    go a.listenForCallback(serverReady)
    
    select {
    case <-serverReady:
    case <-time.After(5 * time.Second):
        return fmt.Errorf("callback server failed to start")
    }
    
    oauthURL := fmt.Sprintf(
        "%s/auth/v1/authorize?provider=google&redirect_to=%s",
        a.supaURL,
        callbackURL,
    )
    openPath(oauthURL)
    return nil
}
```

**2. Local HTTP Server**:
```go
func (a *App) listenForCallback(ready chan struct{}) {
    listener, err := net.Listen("tcp", fmt.Sprintf(":%d", callbackPort))
    close(ready)  // Signal ready
    
    mux := http.NewServeMux()
    mux.HandleFunc("/callback", callbackHandler)
    mux.HandleFunc("/token", tokenHandler)
    server.Serve(listener)
}
```

**3. Callback Handler**:
- Serves HTML page
- Extracts tokens from URL fragment
- POSTs tokens to `/token` endpoint

**4. Token Handler**:
```go
mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
    var tokens struct {
        AccessToken  string `json:"access_token"`
        RefreshToken string `json:"refresh_token"`
    }
    json.Unmarshal(body, &tokens)
    
    user, err := a.supaGetUser(tokens.AccessToken)
    
    a.accessToken = tokens.AccessToken
    a.userID = user.ID
    a.email = user.Email
    
    saveSession(Session{...})
    wailsruntime.EventsEmit(a.ctx, "auth-success", ...)
})
```

### Session Persistence

**Storage Location**:
```
~/.config/duckietown/session.json
```

**Session Structure**:
```go
type Session struct {
    AccessToken  string `json:"access_token"`
    RefreshToken string `json:"refresh_token"`
    UserID       string `json:"user_id"`
    Email        string `json:"email"`
}
```

**Permissions**: 0600 (owner read/write only)

### Token Refresh

**Automatic Refresh**:
```go
func (a *App) supaDo(req *http.Request) (*http.Response, error) {
    resp, err := client.Do(req)
    
    if resp.StatusCode == http.StatusUnauthorized {
        resp.Body.Close()
        
        if refreshErr := a.refreshSession(); refreshErr == nil {
            a.supaHeaders(newReq)
            return client.Do(newReq)
        }
    }
    
    return resp, nil
}
```

**Refresh Logic**:
```go
func (a *App) refreshSession() error {
    url := fmt.Sprintf("%s/auth/v1/token?grant_type=refresh_token", a.supaURL)
    payload := map[string]string{"refresh_token": a.refreshToken}
    
    resp, _ := client.Post(url, payload)
    var res refreshResponse
    json.Decode(resp.Body, &res)
    
    a.accessToken = res.AccessToken
    a.refreshToken = res.RefreshToken
    
    saveSession(Session{...})
    return nil
}
```

**Trigger**: On 401 Unauthorized response

**Retry**: Single retry after refresh

### Session Restoration

**App Startup**:
```go
func (a *App) startup(ctx context.Context) {
    session := loadSession()
    
    if session.RefreshToken != "" {
        a.refreshToken = session.RefreshToken
        a.userID = session.UserID
        a.email = session.Email
        
        err := a.refreshSession()
        if err != nil {
            clearSession()
            wailsruntime.EventsEmit(a.ctx, "auth-expired", nil)
            return
        }
        
        wailsruntime.EventsEmit(a.ctx, "auth-restored", ...)
    }
}
```

**Flow**:
1. Load session from disk
2. Attempt token refresh
3. If successful: restore session
4. If failed: clear and emit auth-expired

### HTTP Client Configuration

**HTTP/1.1 Enforcement**:
```go
var supaHTTPClient = func() *http.Client {
    transport := http.DefaultTransport.(*http.Transport).Clone()
    cloned.ForceAttemptHTTP2 = false
    cloned.TLSClientConfig.NextProtos = []string{"http/1.1"}
    return &http.Client{Timeout: 10 * time.Second, Transport: cloned}
}()
```

**Purpose**: Avoids HTTP/2 issues with Supabase

---

## Database Operations

### Supabase Schema

**Files Table**:
```sql
CREATE TABLE files (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    size BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    folder_path TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, name)
);
```

**Storage Structure**:
```
duckietown/
├── {user_id}/
│   ├── file.pdf
│   ├── work/
│   │   ├── invoice.pdf
│   │   └── report.docx
│   └── photos/
│       └── vacation.jpg
```

### CRUD Operations

**Upsert (Insert or Update)**:
```go
func (a *App) supaUpsertFileRecord(fileName string, size int64, mimeType, storagePath, folderPath string) error {
    row := supaFileRow{
        UserID:      a.userID,
        Name:        fileName,
        Size:        size,
        MimeType:    mimeType,
        StoragePath: storagePath,
        FolderPath:  folderPath,
    }
    
    url := fmt.Sprintf("%s/rest/v1/files?on_conflict=user_id,name", a.supaURL)
    req.Header.Set("Prefer", "resolution=merge-duplicates")
    
    // POST with conflict resolution
}
```

**Conflict Resolution**: `resolution=merge-duplicates` updates on duplicate

**List Files**:
```go
func (a *App) supaListFiles() ([]FileRecord, error) {
    url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&order=updated_at.desc", a.supaURL)
    // GET with user filter and ordering
}
```

**Delete File**:
```go
func (a *App) supaDeleteFileRecord(fileName string) error {
    url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&name=eq.%s", a.supaURL, a.userID, fileName)
    // DELETE with user and name filter
}
```

### Storage Operations

**Upload**:
```go
func (a *App) supaUploadFile(filePath, fileName, folderPath string) error {
    data, _ := os.ReadFile(filePath)
    mimeType := getMimeType(fileName)
    sp := a.storagePath(fileName, folderPath)
    
    url := fmt.Sprintf("%s/storage/v1/object/%s/%s", a.supaURL, bucket, sp)
    req.Header.Set("Content-Type", mimeType)
    req.Header.Set("x-upsert", "true")  // Overwrite if exists
}
```

**Upsert Semantics**: `x-upsert: true` overwrites existing files

**Delete**:
```go
func (a *App) supaDeleteStorageFile(fileName, folderPath string) error {
    sp := a.storagePath(fileName, folderPath)
    url := fmt.Sprintf("%s/storage/v1/object/%s/%s", a.supaURL, bucket, sp)
    // DELETE
}
```

**Signed URL**:
```go
func (a *App) supaGetFileURL(fileName, folderPath string) (string, error) {
    sp := a.storagePath(fileName, folderPath)
    url := fmt.Sprintf("%s/storage/v1/object/sign/%s/%s", a.supaURL, bucket, sp)
    body := `{"expiresIn":3600}`  // 1 hour expiry
    
    // POST to generate signed URL
}
```

**List Storage**:
```go
func (a *App) supaListStorageFiles() ([]string, error) {
    url := fmt.Sprintf("%s/storage/v1/object/list/%s", a.supaURL, bucket)
    body := fmt.Sprintf(`{"prefix":"%s/","limit":10000,"offset":0}`, a.userID)
    
    // POST to list all objects under user prefix
}
```

### Full Synchronization

**Three-Way Sync Logic**:
```go
func (a *App) fullSync() {
    // 1. Build local file map
    localFiles := make(map[string]localEntry)
    filepath.WalkDir(a.vaultPath, func(path string, d os.DirEntry, err error) error {
        if !d.IsDir() {
            name := d.Name()
            fp := a.folderPathForFile(path)
            localFiles[name] = localEntry{path, fp}
        }
        return nil
    })
    
    // 2. Get database files
    dbFiles, _ := a.supaListFiles()
    dbSet := make(map[string]string)
    for _, f := range dbFiles {
        dbSet[f.Name] = f.FolderPath
    }
    
    // 3. Get storage files
    storageFiles, _ := a.supaListStorageFiles()
    storageSet := make(map[string]bool)
    for _, sp := range storageFiles {
        name := parts[len(parts)-1]
        storageSet[name] = true
    }
    
    // 4. Get indexed files from ChromaDB
    indexed, _ := a.GetIndexedFiles()
    
    // 5. Upload new files
    for name, entry := range localFiles {
        if !storageSet[name] {
            a.supaUploadFile(entry.abs, name, entry.folder)
        }
        if !indexed[name] {
            queueIngest(entry.abs, name)
        }
    }
    
    // 6. Delete orphaned DB records
    for _, f := range dbFiles {
        if !localFiles[f.Name] && !storageSet[f.Name] {
            a.supaDeleteFileRecord(f.Name)
        }
    }
    
    // 7. Delete orphaned storage files
    for _, sp := range storageFiles {
        name := parts[len(parts)-1]
        if !localFiles[name] {
            a.supaDeleteStorageFile(name, folder)
            a.supaDeleteFileRecord(name)
            go a.DeleteFileEmbeddings(name)
        }
    }
}
```

**Sync Strategy**:
- Local is source of truth
- Upload missing files to storage
- Ingest missing files to ChromaDB
- Clean up orphaned records
- Clean up orphaned storage objects

---

## Frontend Architecture

### Component Structure

```
src/
├── App.tsx                    # Main application
├── components/
│   ├── authscreen.tsx         # Google OAuth sign-in
│   ├── setupscreen.tsx        # Vault folder selection
│   ├── mainscreen.tsx         # Main file browser
│   ├── filearea.tsx           # File grid/list view
│   ├── foldertree.tsx         # Folder tree navigation
│   ├── sidebar.tsx            # Navigation sidebar
│   ├── searchbar.tsx         # Search input
│   ├── aipanel.tsx            # AI chat panel
│   └── ui/                    # shadcn/ui components
├── lib/
│   ├── wails.ts               # Wails runtime wrapper
│   └── utils.ts               # Utility functions
└── types.ts                   # TypeScript types
```

### State Management

**App-Level State**:
```typescript
const [screen, setScreen] = useState<Screen>("loading");
const [user, setUser] = useState<User | null>(null);
const [files, setFiles] = useState<FileRecord[]>([]);
const [syncing, setSyncing] = useState(false);
const [isWatching, setIsWatching] = useState(false);
const [vaultPath, setVaultPath] = useState<string | null>(null);
```

**Screen States**:
- `loading`: Initial state, checking session
- `auth`: User needs to sign in
- `setup`: User needs to select vault folder
- `main`: Main application interface

### Wails Integration

**Event Listeners**:
```typescript
useEffect(() => {
    wails.on("auth-success", (data: unknown) => {
        const user = data as User;
        setUser(user);
        toast.success("Signed in!", { description: user.email });
    });
    
    wails.on("file-uploaded", (name: string) => {
        setSyncing(false);
        toast.dismiss("sync");
        toast.success("Synced", { description: name });
        loadFiles();
    });
    
    wails.on("chat-token", (data: { content: string }) => {
        // Append token to chat response
    });
    
    return () => {
        wails.off("auth-success");
        wails.off("file-uploaded");
        // ... cleanup
    };
}, []);
```

**Function Calls**:
```typescript
const handleSignIn = async () => {
    await wails.signInWithGoogle();
};

const handleDeleteFile = async (name: string) => {
    await wails.deleteFile(name);
    setFiles((f) => f.filter((x) => x.name !== name));
};

const handleSearch = async (query: string) => {
    const results = await wails.semanticSearch(query, 50);
    // Display results
};
```

### File Operations

**File Grid**:
- Displays files in grid or list view
- Shows file name, size, type
- Context menu for actions (open, rename, delete)

**Folder Tree**:
- Hierarchical folder navigation
- Expand/collapse folders
- Breadcrumb navigation

**Search**:
- Real-time semantic search
- Displays similarity scores
- Shows content snippets
- Filters by file type

### AI Chat Panel

**Chat Interface**:
- Message history display
- Streaming response rendering
- Source file citations
- File-specific chat mode

**Streaming Handler**:
```typescript
useEffect(() => {
    wails.on("chat-token", (data: { content: string }) => {
        setResponse((prev) => prev + data.content);
    });
    
    wails.on("chat-sources", (data: { files: SourceFile[] }) => {
        setSources(data.files);
    });
    
    wails.on("chat-done", () => {
        setIsStreaming(false);
    });
}, []);
```

### Notifications

**Toast System** (Sonner):
```typescript
toast.success("Signed in!", { description: user.email });
toast.loading(`Syncing ${fileName}…`, { id: "sync" });
toast.error("Upload failed", { description: error });
```

**Notification Types**:
- Success: Green, for successful operations
- Loading: Spinner, for in-progress operations
- Error: Red, for failures

---

## Performance Considerations

### Ingestion Optimization

**Rate Limit Handling**:
- Serialized processing (one file at a time)
- Exponential backoff for API rate limits
- Batch processing (8 chunks per request)
- 0.5s delay between batches

**Memory Management**:
- Chunking prevents loading entire files
- Batch upserts to ChromaDB (100 chunks)
- Streaming responses for chat

### Search Optimization

**Indexing**:
- HNSW index in ChromaDB for fast approximate search
- Cosine similarity for efficient distance calculation
- User-isolated collections for scalability

**Deduplication**:
- Single result per file (best chunk)
- Reduces redundant results
- Improves user experience

### Storage Optimization

**Supabase Storage**:
- User-isolated prefixes
- Upsert semantics to avoid duplicates
- Signed URLs for secure access

**ChromaDB**:
- Persistent local storage
- No cloud costs for embeddings
- Fast local retrieval

---

## Security Considerations

### Authentication

**OAuth Flow**:
- Secure token storage (0600 permissions)
- Automatic token refresh
- Session expiration handling

**API Keys**:
- Environment variables for sensitive keys
- Not committed to version control
- Sidecar isolation from frontend

### Data Privacy

**Local Storage**:
- ChromaDB stored locally
- No embeddings sent to cloud (except API calls)
- User-isolated collections

**Cloud Storage**:
- Supabase RLS (Row Level Security) recommended
- User-isolated storage prefixes
- Signed URLs for temporary access

### Network Security

**HTTP/1.1 Enforcement**:
- Avoids HTTP/2 vulnerabilities
- Ensures compatibility with Supabase

**CORS**:
- Sidecar allows all origins (localhost only)
- Frontend communicates via Wails (no direct HTTP)

---

## Deployment

### Desktop Application

**Build Process**:
```bash
# Go backend
wails build

# Python sidecar (PyInstaller)
pyinstaller --onefile sidecar/main.py
```

**Distribution**:
- macOS: .app bundle
- Windows: .exe with embedded sidecar
- Linux: AppImage or binary

### Configuration

**Environment Variables**:
```bash
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
JINA_API_KEY=jina_xxx
OPENROUTER_API_KEY=sk-or-xxx
OPENROUTER_MODEL=google/gemma-3-27b-it
```

**Required APIs**:
- Supabase (free tier sufficient)
- Jina AI (free tier: 100K tokens/month)
- OpenRouter (pay-per-use)

---

## Troubleshooting

### Common Issues

**Sidecar Not Starting**:
- Check port 8000 availability
- Verify Python installation
- Check environment variables
- Review sidecar logs

**Ingestion Failures**:
- Verify Jina API key
- Check rate limits
- Review file permissions
- Check sidecar health

**Search Not Working**:
- Verify ChromaDB directory
- Check indexed files
- Verify embeddings exist
- Review similarity threshold

**Authentication Issues**:
- Verify Supabase credentials
- Check callback URL configuration
- Review session file permissions
- Check network connectivity

---

## Future Enhancements

**Potential Improvements**:
1. **Hybrid Search**: Combine semantic with keyword search
2. **Re-ranking**: Use cross-encoder for better ranking
3. **Multi-user Support**: Shared vaults with permissions
4. **Mobile App**: React Native or Flutter
5. **Offline Mode**: Local-only mode with sync on reconnect
6. **Advanced Filters**: Date range, size, type filters
7. **Batch Operations**: Bulk rename, move, delete
8. **Version History**: Track file changes over time
9. **Web Interface**: Browser-based access
10. **More File Types**: Support for additional formats

---

## Conclusion

Duckietown represents a sophisticated integration of modern technologies to create an intelligent file management system. The combination of:

- **Go** for robust backend orchestration
- **Python** for AI/ML capabilities
- **React** for modern UI
- **Supabase** for cloud infrastructure
- **ChromaDB** for vector search

Creates a seamless experience where users can search their files using natural language and receive AI-powered assistance grounded in their actual content.

The system's architecture emphasizes:
- **Modularity**: Clear separation of concerns
- **Performance**: Optimized batch processing and streaming
- **Reliability**: Robust error handling and retry logic
- **Privacy**: Local-first approach with secure cloud sync
- **Extensibility**: Easy to add new file types and AI features

This documentation provides a comprehensive understanding of the system's implementation, from low-level file monitoring to high-level AI interactions.
