import { useState } from "react";
import {
  ExternalLink,
  Trash2,
  Pencil,
  MoreHorizontal,
  Sparkles,
  Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import type {
  FileRecord,
  ViewMode,
  SearchResult,
  FolderRecord,
} from "../types";
import { formatBytes, formatDate } from "../lib/utils";
import { FileTypeIcon, isImageType, kindLabel } from "../lib/filetypes";
import { vaultFileUrl } from "../lib/vaultfile";

// Shared column template — used by the list header AND every row (file and
// folder) so they can never drift out of alignment with each other.
const LIST_GRID_COLUMNS = "32px minmax(0,1fr) 150px 72px 92px 116px";

// ── Similarity badge ───────────────────────────────────

function SimilarityBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 80
      ? "text-indigo-300 border-indigo-400/40"
      : pct >= 50
        ? "text-indigo-400/70 border-indigo-500/30"
        : "text-[#6a6a6a] border-[#3e3e42]";
  return (
    <span
      className={`text-[9px] font-mono border rounded px-1 py-0.5 whitespace-nowrap bg-[#1a1a1a] ${color}`}
    >
      {pct}%
    </span>
  );
}

// ── Inline rename ──────────────────────────────────────

function RenameInput({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: (n: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(name);
  return (
    <Input
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onConfirm(val);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onConfirm(val)}
      className="h-6 text-[11px] px-1.5 py-0 bg-[#1e1e1e] border-indigo-500 text-center"
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ── Image thumbnail — renders the file's own content, like Explorer does,
// not a generic icon. Points straight at the local vault file (served by
// the Go backend, see internal/vault/httpserve.go) so the common case
// costs zero network calls and zero IPC — no signed-URL round trip, no
// base64 inflation, just a normal <img> load the webview caches like any
// other asset. Only touches onGetPreview's Supabase signed URL as a
// fallback for a file not yet present locally, and the file-type icon as
// the last resort if neither works. Never silently blank. ─────────────

function ImageThumb({
  file,
  onGetPreview,
  size = 32,
}: {
  file: { name: string; folder_path: string; mime_type: string };
  onGetPreview: (n: string) => Promise<string>;
  size?: number;
}) {
  const [stage, setStage] = useState<"local" | "remote" | "error">("local");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [loaded, setLoaded] = useState(false);

  const tryRemote = () => {
    setLoaded(false);
    onGetPreview(file.name)
      .then((u) => {
        setRemoteUrl(u);
        setStage("remote");
      })
      .catch(() => setStage("error"));
  };

  if (stage === "error") {
    return <FileTypeIcon name={file.name} mime={file.mime_type} size={size} />;
  }

  const src = stage === "local" ? vaultFileUrl(file.name, file.folder_path) : remoteUrl;

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden rounded-[inherit]">
      {!loaded && (
        <div className="absolute inset-0 bg-[#2a2a2a] animate-pulse rounded-[inherit]" />
      )}
      {src && (
        <img
          src={src}
          alt={file.name}
          className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={stage === "local" ? tryRemote : () => setStage("error")}
        />
      )}
    </div>
  );
}

// ── Move-to submenu ────────────────────────────────────

function MoveToMenu({
  folders,
  currentFolder,
  onMove,
}: {
  folders: FolderRecord[];
  currentFolder: string;
  onMove: (path: string) => void;
}) {
  const options: Array<{ path: string; label: string }> = [
    { path: "", label: "Root (Vault)" },
    ...folders
      .filter((f) => f.path !== currentFolder)
      .map((f) => ({ path: f.path, label: f.name })),
  ];
  return (
    <>
      {options.map((opt) => (
        <ContextMenuItem key={opt.path} onClick={() => onMove(opt.path)}>
          <FileTypeIcon folder size={12} className="mr-2" />
          {opt.label}
        </ContextMenuItem>
      ))}
    </>
  );
}

// ── Grid tile (Explorer "large icons" style) ───────────

function FileTile({
  file,
  similarity,
  inAiMode,
  folders,
  currentFolder,
  selected,
  onSelect,
  onDelete,
  onRename,
  onOpen,
  onGetPreview,
  onAskAi,
  onMoveToFolder,
}: {
  file: FileRecord;
  similarity?: number;
  inAiMode: boolean;
  folders: FolderRecord[];
  currentFolder: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: (n: string) => void;
  onRename: (old: string, n: string) => void;
  onOpen: (n: string) => void;
  onGetPreview: (n: string) => Promise<string>;
  onAskAi: (n: string) => void;
  onMoveToFolder: (name: string, path: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const isImage = isImageType(file.mime_type, file.name);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", file.name);
            setDragging(true);
          }}
          onDragEnd={() => setDragging(false)}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          onDoubleClick={() => onOpen(file.name)}
          className={`group relative flex flex-col items-center gap-1.5 rounded-md p-2.5 cursor-pointer select-none
            transition-colors duration-150 fade-in
            ${selected ? "bg-indigo-500/15 hover:bg-indigo-500/20" : "hover:bg-white/[0.06]"}
            ${dragging ? "opacity-40" : ""}
            ${inAiMode && similarity !== undefined && similarity >= 0.5 ? "ring-1 ring-indigo-500/40" : ""}`}
        >
          <div className="relative flex items-center justify-center w-16 h-16 shrink-0">
            {isImage ? (
              <ImageThumb file={file} onGetPreview={onGetPreview} size={64} />
            ) : (
              <FileTypeIcon name={file.name} mime={file.mime_type} size={56} />
            )}
            {inAiMode && similarity !== undefined && (
              <div className="absolute -top-1 -right-1">
                <SimilarityBadge score={similarity} />
              </div>
            )}
          </div>

          {renaming ? (
            <RenameInput
              name={file.name}
              onConfirm={(n) => {
                setRenaming(false);
                if (n && n !== file.name) onRename(file.name, n);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="text-[11px] leading-tight text-[#d4d4d4] text-center line-clamp-2 break-words px-0.5 w-full">
                    {file.name}
                  </p>
                </TooltipTrigger>
                <TooltipContent className="text-xs font-mono max-w-xs break-all">
                  {file.name}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="absolute top-1 right-1 w-5 h-5 rounded-md bg-black/40 backdrop-blur-sm
                  flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={11} className="text-white" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="text-xs">
              <DropdownMenuItem onClick={() => onOpen(file.name)}>
                <ExternalLink size={12} className="mr-2" /> Open
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAskAi(file.name)}>
                <Sparkles size={12} className="mr-2" /> Ask AI
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <Pencil size={12} className="mr-2" /> Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(file.name)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={12} className="mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onOpen(file.name)}>
          <ExternalLink size={13} className="mr-2" /> Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAskAi(file.name)}>
          <Sparkles size={13} className="mr-2" /> Ask AI / Summarise
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setRenaming(true)}>
          <Pencil size={13} className="mr-2" /> Rename
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FileTypeIcon folder size={13} className="mr-2" /> Move to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <MoveToMenu
              folders={folders}
              currentFolder={currentFolder}
              onMove={(path) => onMoveToFolder(file.name, path)}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => onDelete(file.name)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 size={13} className="mr-2" /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FolderTile({
  folder,
  selected,
  onSelect,
  onOpen,
  onDrop,
}: {
  folder: FolderRecord;
  selected: boolean;
  onSelect: () => void;
  onOpen: (path: string) => void;
  onDrop: (fileName: string, folderPath: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`group relative flex flex-col items-center gap-1.5 rounded-md p-2.5 cursor-pointer select-none
        transition-colors duration-150 fade-in
        ${
          dragOver
            ? "bg-indigo-500/15 ring-1 ring-indigo-500/40"
            : selected
              ? "bg-indigo-500/15 hover:bg-indigo-500/20"
              : "hover:bg-white/[0.06]"
        }`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onDoubleClick={() => onOpen(folder.path)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const fileName = e.dataTransfer.getData("text/plain");
        if (fileName) onDrop(fileName, folder.path);
      }}
    >
      <div className="flex items-center justify-center w-16 h-16 shrink-0">
        <FileTypeIcon folder size={56} />
      </div>
      <p className="text-[11px] leading-tight text-[#d4d4d4] text-center line-clamp-2 break-words px-0.5 w-full">
        {folder.name}
      </p>
    </div>
  );
}

// ── File Row (list view) ───────────────────────────────

function FileRow({
  file,
  similarity,
  inAiMode,
  folders,
  currentFolder,
  onDelete,
  onRename,
  onOpen,
  onGetPreview,
  onAskAi,
  onMoveToFolder,
}: {
  file: FileRecord;
  similarity?: number;
  inAiMode: boolean;
  folders: FolderRecord[];
  currentFolder: string;
  onDelete: (n: string) => void;
  onRename: (old: string, n: string) => void;
  onOpen: (n: string) => void;
  onGetPreview: (n: string) => Promise<string>;
  onAskAi: (n: string) => void;
  onMoveToFolder: (name: string, path: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const isImage = isImageType(file.mime_type, file.name);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/plain", file.name)}
          className={`group grid items-center gap-2 px-2 py-1.5 rounded-md transition-colors fade-in cursor-grab active:cursor-grabbing min-w-0
            ${
              inAiMode && similarity !== undefined && similarity >= 0.5
                ? "ring-1 ring-inset ring-indigo-500/25 hover:bg-[#242428]"
                : "hover:bg-[#242428]"
            }`}
          style={{ gridTemplateColumns: LIST_GRID_COLUMNS }}
        >
          <div className="w-7 h-7 rounded-md overflow-hidden bg-[#1e1e1e] flex items-center justify-center shrink-0">
            {isImage ? (
              <ImageThumb file={file} onGetPreview={onGetPreview} size={28} />
            ) : (
              <FileTypeIcon name={file.name} mime={file.mime_type} size={16} />
            )}
          </div>

          <div className="min-w-0">
            {renaming ? (
              <RenameInput
                name={file.name}
                onConfirm={(n) => {
                  setRenaming(false);
                  if (n !== file.name) onRename(file.name, n);
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <span
                className="text-xs font-medium truncate block cursor-pointer hover:text-indigo-400 transition-colors"
                onClick={() => onOpen(file.name)}
              >
                {file.name}
              </span>
            )}
          </div>

          <span className="text-[11px] text-[#7a7a7a] truncate min-w-0">
            {kindLabel(file.mime_type, file.name)}
          </span>

          <span className="text-[11px] font-mono text-[#6a6a6a] whitespace-nowrap">
            {formatBytes(file.size)}
          </span>

          <div className="flex items-center min-w-0">
            {inAiMode && similarity !== undefined ? (
              <SimilarityBadge score={similarity} />
            ) : (
              <span className="text-[11px] text-[#6a6a6a] whitespace-nowrap">
                {formatDate(file.updated_at)}
              </span>
            )}
          </div>

          <div className="flex items-center justify-end shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-[#6a6a6a] hover:text-[#d4d4d4]"
              onClick={() => onOpen(file.name)}
            >
              <ExternalLink size={11} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-[#6a6a6a] hover:text-indigo-400"
              onClick={() => onAskAi(file.name)}
            >
              <Sparkles size={11} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-[#6a6a6a] hover:text-[#d4d4d4]"
              onClick={() => setRenaming(true)}
            >
              <Pencil size={11} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-[#6a6a6a] hover:text-destructive"
              onClick={() => onDelete(file.name)}
            >
              <Trash2 size={11} />
            </Button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onOpen(file.name)}>
          <ExternalLink size={13} className="mr-2" /> Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAskAi(file.name)}>
          <Sparkles size={13} className="mr-2" /> Ask AI / Summarise
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setRenaming(true)}>
          <Pencil size={13} className="mr-2" /> Rename
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FileTypeIcon folder size={13} className="mr-2" /> Move to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <MoveToMenu
              folders={folders}
              currentFolder={currentFolder}
              onMove={(path) => onMoveToFolder(file.name, path)}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => onDelete(file.name)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 size={13} className="mr-2" /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ── FileArea ───────────────────────────────────────────

interface Props {
  files: FileRecord[];
  view: ViewMode;
  searchQuery: string;
  aiResults: SearchResult[];
  currentFolder: string;
  folders: FolderRecord[];
  onDelete: (n: string) => void;
  onRename: (old: string, n: string) => void;
  onOpen: (n: string) => void;
  onGetPreview: (n: string) => Promise<string>;
  onAskAi: (n: string) => void;
  onMoveToFolder: (fileName: string, targetPath: string) => void;
  onNavigateFolder: (path: string) => void;
}

export function FileArea({
  files,
  view,
  searchQuery,
  aiResults,
  currentFolder,
  folders,
  onDelete,
  onRename,
  onOpen,
  onGetPreview,
  onAskAi,
  onMoveToFolder,
  onNavigateFolder,
}: Props) {
  const similarityMap = Object.fromEntries(
    aiResults.map((r) => [r.file_name, r.similarity]),
  );
  const inAiMode = aiResults.length > 0;

  // Selection doesn't carry meaning across navigation/search changes.
  // Adjusted during render (React's documented pattern for resetting state
  // when a prop changes) rather than an effect, to avoid an extra render pass.
  const selectionScope = `${currentFolder}::${inAiMode}`;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [lastSelectionScope, setLastSelectionScope] = useState(selectionScope);
  if (selectionScope !== lastSelectionScope) {
    setLastSelectionScope(selectionScope);
    setSelectedKey(null);
  }

  // Hide folders when AI search is active — only show ranked files
  const subfolders = inAiMode
    ? []
    : folders.filter((f) => f.parent === currentFolder);

  const shared = {
    inAiMode,
    folders,
    currentFolder,
    onDelete,
    onRename,
    onOpen,
    onGetPreview,
    onAskAi,
    onMoveToFolder,
  };

  if (files.length === 0 && subfolders.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-16 overflow-hidden">
        <div className="w-16 h-16 rounded-2xl bg-[#252526] border border-[#3e3e42] flex items-center justify-center">
          <Package size={28} strokeWidth={1} className="text-[#3e3e42]" />
        </div>
        <p className="text-sm font-medium text-[#6a6a6a]">Empty</p>
        <p className="text-xs text-[#4a4a4a] text-center max-w-xs leading-relaxed">
          {searchQuery
            ? `No files match "${searchQuery}"`
            : "Drop files here or create a subfolder."}
        </p>
      </div>
    );
  }

  if (view === "list") {
    return (
      // flex-1 + min-h-0 ensures this column can shrink and scroll
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div
          className="grid gap-2 px-3 py-2 border-b border-[#2a2a2e] bg-[#1e1e1e] text-[10px] font-semibold uppercase tracking-widest text-[#4a4a4a] shrink-0"
          style={{ gridTemplateColumns: LIST_GRID_COLUMNS }}
        >
          <span />
          <span>Name</span>
          <span>Kind</span>
          <span>Size</span>
          <span>{inAiMode ? "Match" : "Date"}</span>
          <span className="text-right">Actions</span>
        </div>
        {/* ScrollArea fills remaining space */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-2 py-1.5 flex flex-col gap-0.5">
            {subfolders.map((folder) => (
              <div
                key={folder.path}
                className="group grid items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#242428] transition-colors cursor-pointer min-w-0"
                style={{ gridTemplateColumns: LIST_GRID_COLUMNS }}
                onDoubleClick={() => onNavigateFolder(folder.path)}
              >
                <div className="w-7 h-7 flex items-center justify-center">
                  <FileTypeIcon folder size={18} />
                </div>
                <span className="text-xs font-medium text-[#d4d4d4] truncate">
                  {folder.name}
                </span>
                <span className="text-[11px] text-[#7a7a7a]">Folder</span>
                <span />
                <span />
                <span />
              </div>
            ))}
            {files.map((f) => (
              <FileRow
                key={f.name}
                file={f}
                similarity={similarityMap[f.name]}
                {...shared}
              />
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Grid view — Explorer "large icons" style
  return (
    <ScrollArea className="flex-1 min-h-0">
      <div
        className="p-4 grid gap-1"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))" }}
        onClick={() => setSelectedKey(null)}
      >
        {subfolders.map((folder) => {
          const key = `folder:${folder.path}`;
          return (
            <FolderTile
              key={key}
              folder={folder}
              selected={selectedKey === key}
              onSelect={() => setSelectedKey(key)}
              onOpen={onNavigateFolder}
              onDrop={onMoveToFolder}
            />
          );
        })}
        {files.map((f) => {
          const key = `file:${f.name}`;
          return (
            <FileTile
              key={key}
              file={f}
              similarity={similarityMap[f.name]}
              selected={selectedKey === key}
              onSelect={() => setSelectedKey(key)}
              {...shared}
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}
