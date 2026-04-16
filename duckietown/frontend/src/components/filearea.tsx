import { useState, useEffect } from "react";
import {
  FileText,
  FileType,
  Image,
  Video,
  Music,
  Package,
  FileSpreadsheet,
  Archive,
  ExternalLink,
  Trash2,
  Pencil,
  MoreHorizontal,
  Sparkles,
  Folder,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

// ── File type helpers ──────────────────────────────────

function getIconMeta(
  mime: string,
  name: string,
  size = 28,
): { icon: React.ReactNode; color: string; label: string } {
  const p = { size, strokeWidth: 1.4 };
  if (mime.startsWith("image/"))
    return { icon: <Image {...p} />, color: "#7dd3fc", label: "Image" };
  if (mime.startsWith("video/"))
    return { icon: <Video {...p} />, color: "#a78bfa", label: "Video" };
  if (mime.startsWith("audio/"))
    return { icon: <Music {...p} />, color: "#34d399", label: "Audio" };
  if (mime.includes("pdf"))
    return { icon: <FileText {...p} />, color: "#f87171", label: "PDF" };
  if (
    mime.includes("wordprocessingml") ||
    mime.includes("msword") ||
    name.endsWith(".docx") ||
    name.endsWith(".doc")
  )
    return { icon: <FileType {...p} />, color: "#60a5fa", label: "Word" };
  if (
    mime.includes("spreadsheetml") ||
    mime.includes("ms-excel") ||
    name.endsWith(".xlsx") ||
    name.endsWith(".csv")
  )
    return {
      icon: <FileSpreadsheet {...p} />,
      color: "#4ade80",
      label: "Sheet",
    };
  if (
    mime.includes("zip") ||
    mime.includes("tar") ||
    name.endsWith(".zip") ||
    name.endsWith(".rar")
  )
    return { icon: <Archive {...p} />, color: "#fbbf24", label: "Archive" };
  if (mime.includes("text"))
    return { icon: <FileText {...p} />, color: "#94a3b8", label: "Text" };
  return { icon: <Package {...p} />, color: "#6b7280", label: "File" };
}

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
      className={`text-[9px] font-mono border rounded px-1 py-0.5 ${color}`}
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

// ── Image thumbnail with lazy loading ─────────────────

function ImageThumb({
  name,
  onGetPreview,
}: {
  name: string;
  onGetPreview: (n: string) => Promise<string>;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    onGetPreview(name)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => setError(true));
    return () => {
      cancelled = true;
    };
  }, [name, onGetPreview]);

  if (error || !url) return null;
  return (
    <>
      {!loaded && (
        <div className="absolute inset-0 bg-[#2a2a2a] animate-pulse" />
      )}
      <img
        src={url}
        alt={name}
        className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
    </>
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
          <Folder size={12} className="mr-2 text-indigo-400/70" />
          {opt.label}
        </ContextMenuItem>
      ))}
    </>
  );
}

// ── macOS-style File Card (grid) ───────────────────────

function FileCard({
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
  const [dragging, setDragging] = useState(false);
  const isImage = file.mime_type.startsWith("image/");
  const { icon, color } = getIconMeta(file.mime_type, file.name);
  const ext = file.name.split(".").pop()?.toUpperCase() ?? "";

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
          className={`group relative flex flex-col rounded-xl overflow-hidden cursor-pointer select-none
            border transition-all duration-150 fade-in
            ${
              inAiMode && similarity !== undefined && similarity >= 0.5
                ? "border-indigo-500/40 bg-[#252526]"
                : "border-[#323236] bg-[#252526] hover:border-[#484850]"
            }
            ${dragging ? "opacity-40 scale-95" : "hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-black/50"}`}
          onDoubleClick={() => onOpen(file.name)}
        >
          {/* Preview area */}
          <div
            className="relative flex items-center justify-center overflow-hidden bg-[#1e1e1e]"
            style={{ height: 120 }}
          >
            {isImage ? (
              <ImageThumb name={file.name} onGetPreview={onGetPreview} />
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 w-full h-full">
                <div style={{ color }} className="opacity-90">
                  {icon}
                </div>
                {ext && (
                  <span
                    className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded"
                    style={{ color, backgroundColor: `${color}18` }}
                  >
                    {ext}
                  </span>
                )}
              </div>
            )}

            {/* AI similarity badge overlay */}
            {inAiMode && similarity !== undefined && (
              <div className="absolute top-1.5 right-1.5">
                <SimilarityBadge score={similarity} />
              </div>
            )}

            {/* Hover open overlay */}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(file.name);
                }}
                className="bg-white/10 backdrop-blur-sm border border-white/20 rounded-lg px-3 py-1.5 text-[11px] text-white font-medium"
              >
                Open
              </button>
            </div>
          </div>

          {/* Info bar */}
          <div className="px-2.5 py-2 flex flex-col gap-0.5">
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
                    <p className="text-[11px] font-medium truncate leading-tight text-[#d4d4d4] text-center">
                      {file.name}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs font-mono">
                    {file.name}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <p className="text-[10px] font-mono text-[#4a4a4a] text-center">
              {formatBytes(file.size)}
            </p>
          </div>

          {/* Three-dot menu on hover */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="absolute top-1.5 left-1.5 w-6 h-6 rounded-md bg-black/40 backdrop-blur-sm
                  flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={12} className="text-white" />
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
            <Folder size={13} className="mr-2" /> Move to
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

// ── macOS-style Folder Card ────────────────────────────

function FolderCard({
  folder,
  onOpen,
  onDrop,
}: {
  folder: FolderRecord;
  onOpen: (path: string) => void;
  onDrop: (fileName: string, folderPath: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`group relative flex flex-col rounded-xl overflow-hidden cursor-pointer select-none
        border transition-all duration-150 fade-in
        ${
          dragOver
            ? "border-indigo-500/60 bg-indigo-500/10 scale-105"
            : "border-[#323236] bg-[#252526] hover:border-[#484850] hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-black/50"
        }`}
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
      <div
        className="relative flex items-center justify-center bg-[#1e1e1e]"
        style={{ height: 120 }}
      >
        {/* macOS-style folder SVG */}
        <svg
          width="72"
          height="60"
          viewBox="0 0 72 60"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4 14C4 11.2386 6.23858 9 9 9H28L34 16H63C65.7614 16 68 18.2386 68 21V52C68 54.7614 65.7614 57 63 57H9C6.23858 57 4 54.7614 4 52V14Z"
            fill="#4a7fcb"
            opacity="0.85"
          />
          <path
            d="M4 22C4 19.2386 6.23858 17 9 17H63C65.7614 17 68 19.2386 68 22V52C68 54.7614 65.7614 57 63 57H9C6.23858 57 4 54.7614 4 52V22Z"
            fill="#5b8fd9"
          />
          <path
            d="M4 22C4 19.2386 6.23858 17 9 17H63C65.7614 17 68 19.2386 68 22V28H4V22Z"
            fill="white"
            opacity="0.08"
          />
        </svg>
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-indigo-500/10">
            <span className="text-[10px] text-indigo-300 font-medium bg-indigo-500/20 rounded-lg px-2 py-1">
              Drop here
            </span>
          </div>
        )}
      </div>

      <div className="px-2.5 py-2 flex flex-col gap-0.5">
        <p className="text-[11px] font-medium truncate leading-tight text-[#d4d4d4] text-center">
          {folder.name}
        </p>
        <p className="text-[10px] font-mono text-[#4a4a4a] text-center">
          {folder.children > 0
            ? `${folder.children} subfolder${folder.children !== 1 ? "s" : ""}`
            : "folder"}
        </p>
      </div>
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
  const isImage = file.mime_type.startsWith("image/");
  // Use size=16 directly — no cloneElement needed
  const { icon, color } = getIconMeta(file.mime_type, file.name, 16);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/plain", file.name)}
          className={`grid items-center gap-3 px-3 py-2 rounded-lg border transition-colors fade-in cursor-grab active:cursor-grabbing
            ${
              inAiMode && similarity !== undefined && similarity >= 0.5
                ? "border-indigo-500/20 hover:bg-[#2a2a2e] hover:border-indigo-500/30"
                : "border-transparent hover:bg-[#2a2a2e] hover:border-[#3e3e42]"
            }`}
          style={{ gridTemplateColumns: "32px 1fr 80px 70px 100px 80px" }}
        >
          {/* Icon */}
          <div className="w-8 h-8 rounded-lg overflow-hidden bg-[#1e1e1e] flex items-center justify-center shrink-0">
            {isImage ? (
              <div className="w-full h-full relative">
                <ImageThumb name={file.name} onGetPreview={onGetPreview} />
              </div>
            ) : (
              <div style={{ color }} className="opacity-80">
                {icon}
              </div>
            )}
          </div>

          {/* Name */}
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

          <Badge
            variant="outline"
            className="text-[9px] font-mono uppercase tracking-wide h-4 px-1.5 w-fit"
          >
            {file.mime_type.split("/")[1]?.split(";")[0] ?? "file"}
          </Badge>

          <span className="text-[11px] font-mono text-[#6a6a6a]">
            {formatBytes(file.size)}
          </span>

          {inAiMode && similarity !== undefined ? (
            <SimilarityBadge score={similarity} />
          ) : (
            <span className="text-[11px] text-[#6a6a6a]">
              {formatDate(file.updated_at)}
            </span>
          )}

          <div className="flex items-center gap-0.5 justify-end">
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-[#6a6a6a] hover:text-[#d4d4d4]"
              onClick={() => onOpen(file.name)}
            >
              <ExternalLink size={12} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-[#6a6a6a] hover:text-indigo-400"
              onClick={() => onAskAi(file.name)}
            >
              <Sparkles size={12} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-[#6a6a6a] hover:text-[#d4d4d4]"
              onClick={() => setRenaming(true)}
            >
              <Pencil size={12} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-[#6a6a6a] hover:text-destructive"
              onClick={() => onDelete(file.name)}
            >
              <Trash2 size={12} />
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
            <Folder size={13} className="mr-2" /> Move to
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
  const subfolders = folders.filter((f) => f.parent === currentFolder);

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
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-16">
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
      <div className="flex flex-col flex-1 overflow-hidden">
        <div
          className="grid gap-3 px-3 py-2 border-b border-[#3e3e42] bg-[#1e1e1e] text-[10px] font-semibold uppercase tracking-widest text-[#4a4a4a] shrink-0"
          style={{ gridTemplateColumns: "32px 1fr 80px 70px 100px 80px" }}
        >
          <span />
          <span>Name</span>
          <span>Kind</span>
          <span>Size</span>
          <span>{inAiMode ? "Match" : "Modified"}</span>
          <span className="text-right">Actions</span>
        </div>
        <ScrollArea className="flex-1">
          <div className="px-2 py-1.5 flex flex-col gap-0.5">
            {subfolders.map((folder) => (
              <div
                key={folder.path}
                className="grid items-center gap-3 px-3 py-2 rounded-lg border border-transparent
                  hover:bg-[#2a2a2e] hover:border-[#3e3e42] transition-colors cursor-pointer"
                style={{ gridTemplateColumns: "32px 1fr 80px 70px 100px 80px" }}
                onDoubleClick={() => onNavigateFolder(folder.path)}
              >
                <div className="w-8 h-8 flex items-center justify-center">
                  <Folder
                    size={18}
                    className="text-[#5b8fd9]"
                    strokeWidth={1.5}
                  />
                </div>
                <span className="text-xs font-medium text-[#d4d4d4]">
                  {folder.name}
                </span>
                <Badge
                  variant="outline"
                  className="text-[9px] font-mono h-4 px-1.5 w-fit"
                >
                  folder
                </Badge>
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

  return (
    <ScrollArea className="flex-1">
      <div
        className="p-4 grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
      >
        {subfolders.map((folder) => (
          <FolderCard
            key={folder.path}
            folder={folder}
            onOpen={onNavigateFolder}
            onDrop={onMoveToFolder}
          />
        ))}
        {files.map((f) => (
          <FileCard
            key={f.name}
            file={f}
            similarity={similarityMap[f.name]}
            {...shared}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
