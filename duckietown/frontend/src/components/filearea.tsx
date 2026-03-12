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
import type { FileRecord, ViewMode } from "../types";
import { formatBytes, formatDate } from "../lib/utils";

// ── Icons ──────────────────────────────────────────────

function FileIcon({
  mime,
  name,
  size = 28,
}: {
  mime: string;
  name: string;
  size?: number;
}) {
  const p = { size, strokeWidth: 1.5 };
  if (mime.startsWith("image/")) return <Image {...p} className="icon-img" />;
  if (mime.startsWith("video/")) return <Video {...p} className="icon-vid" />;
  if (mime.startsWith("audio/")) return <Music {...p} className="icon-aud" />;
  if (mime.includes("pdf")) return <FileText {...p} className="icon-pdf" />;
  if (
    mime.includes("wordprocessingml") ||
    mime.includes("msword") ||
    name.endsWith(".docx") ||
    name.endsWith(".doc")
  )
    return <FileType {...p} className="icon-doc" />;
  if (
    mime.includes("spreadsheetml") ||
    mime.includes("ms-excel") ||
    name.endsWith(".xlsx") ||
    name.endsWith(".csv")
  )
    return <FileSpreadsheet {...p} className="icon-sheet" />;
  if (
    mime.includes("zip") ||
    mime.includes("tar") ||
    name.endsWith(".zip") ||
    name.endsWith(".rar")
  )
    return <Archive {...p} className="icon-zip" />;
  if (mime.includes("text")) return <FileText {...p} className="icon-doc" />;
  return <Package {...p} className="icon-pkg" />;
}

// ── Highlight match ────────────────────────────────────

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <span>{text}</span>;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i === -1) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, i)}
      <mark className="bg-indigo-500/30 text-[#d4d4d4] rounded-sm">
        {text.slice(i, i + query.length)}
      </mark>
      {text.slice(i + query.length)}
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
      className="h-6 text-[11px] px-1.5 py-0 bg-[#1e1e1e] border-indigo-500"
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ── Image preview ──────────────────────────────────────

function ImageThumb({
  name,
  onGetPreview,
  className = "",
}: {
  name: string;
  onGetPreview: (n: string) => Promise<string>;
  className?: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);

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
    <img
      src={url}
      alt={name}
      className={`object-cover w-full h-full ${className}`}
      loading="lazy"
      onError={() => setError(true)}
    />
  );
}

// ── File Card (grid) ───────────────────────────────────

function FileCard({
  file,
  query,
  onDelete,
  onRename,
  onOpen,
  onGetPreview,
}: {
  file: FileRecord;
  query: string;
  onDelete: (n: string) => void;
  onRename: (old: string, newN: string) => void;
  onOpen: (n: string) => void;
  onGetPreview: (n: string) => Promise<string>;
}) {
  const [renaming, setRenaming] = useState(false);
  const ext = file.name.split(".").pop()?.toUpperCase() ?? "FILE";

  const handleRename = (newName: string) => {
    setRenaming(false);
    if (newName && newName !== file.name) onRename(file.name, newName);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className="file-card relative bg-[#252526] border border-[#3e3e42] rounded-lg overflow-hidden cursor-pointer
            transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/30 hover:border-[#505050] fade-in"
          onDoubleClick={() => onOpen(file.name)}
        >
          {/* Preview area */}
          <div className="h-[90px] bg-[#2d2d30] border-b border-[#3e3e42] overflow-hidden relative flex items-center justify-center">
            {file.mime_type.startsWith("image/") ? (
              <ImageThumb name={file.name} onGetPreview={onGetPreview} />
            ) : (
              <>
                <FileIcon mime={file.mime_type} name={file.name} size={30} />
                <span className="absolute bottom-1 text-[9px] font-mono text-[#4a4a4a] uppercase">
                  {ext}
                </span>
              </>
            )}
          </div>

          {/* Info */}
          <div className="px-2.5 pt-2 pb-8">
            {renaming ? (
              <RenameInput
                name={file.name}
                onConfirm={handleRename}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="text-[11px] font-medium truncate leading-tight text-[#d4d4d4]">
                      <Highlight text={file.name} query={query} />
                    </p>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs font-mono">
                    {file.name}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <p className="text-[10px] font-mono text-[#6a6a6a] mt-0.5">
              {formatBytes(file.size)}
            </p>
          </div>

          {/* Hover actions */}
          <div
            className="card-actions absolute bottom-0 left-0 right-0 flex items-center gap-1 p-1.5
            bg-gradient-to-t from-[#252526] to-transparent"
          >
            <Button
              variant="secondary"
              size="sm"
              className="flex-1 h-6 text-[10px] gap-1"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(file.name);
              }}
            >
              <ExternalLink size={10} /> Open
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-6 h-6"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal size={11} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="text-xs">
                <DropdownMenuItem onClick={() => onOpen(file.name)}>
                  <ExternalLink size={12} className="mr-2" /> Open
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
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onOpen(file.name)}>
          <ExternalLink size={13} className="mr-2" /> Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setRenaming(true)}>
          <Pencil size={13} className="mr-2" /> Rename
        </ContextMenuItem>
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

// ── File Row (list) ────────────────────────────────────

function FileRow({
  file,
  query,
  onDelete,
  onRename,
  onOpen,
  onGetPreview,
}: {
  file: FileRecord;
  query: string;
  onDelete: (n: string) => void;
  onRename: (old: string, newN: string) => void;
  onOpen: (n: string) => void;
  onGetPreview: (n: string) => Promise<string>;
}) {
  const [renaming, setRenaming] = useState(false);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className="grid items-center gap-2 px-3 py-2 rounded-md border border-transparent
          hover:bg-[#2d2d30] hover:border-[#3e3e42] transition-colors fade-in"
          style={{ gridTemplateColumns: "32px 1fr 90px 72px 110px 72px" }}
        >
          {/* Thumb / icon */}
          <div className="w-8 h-8 rounded overflow-hidden bg-[#2d2d30] flex items-center justify-center shrink-0">
            {file.mime_type.startsWith("image/") ? (
              <ImageThumb name={file.name} onGetPreview={onGetPreview} />
            ) : (
              <FileIcon mime={file.mime_type} name={file.name} size={15} />
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
                <Highlight text={file.name} query={query} />
              </span>
            )}
          </div>

          {/* Type badge */}
          <Badge
            variant="outline"
            className="text-[9px] font-mono uppercase tracking-wide h-4 px-1.5 w-fit"
          >
            {file.mime_type.split("/")[1]?.split(";")[0] ?? "file"}
          </Badge>

          <span className="text-[11px] font-mono text-[#6a6a6a]">
            {formatBytes(file.size)}
          </span>
          <span className="text-[11px] text-[#6a6a6a]">
            {formatDate(file.updated_at)}
          </span>

          {/* Actions */}
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
        <ContextMenuItem onClick={() => setRenaming(true)}>
          <Pencil size={13} className="mr-2" /> Rename
        </ContextMenuItem>
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
  onDelete: (n: string) => void;
  onRename: (old: string, newN: string) => void;
  onOpen: (n: string) => void;
  onGetPreview: (n: string) => Promise<string>;
}

export function FileArea({
  files,
  view,
  searchQuery,
  onDelete,
  onRename,
  onOpen,
  onGetPreview,
}: Props) {
  if (files.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-16">
        <Package size={48} strokeWidth={1} className="text-[#3e3e42]" />
        <p className="text-sm font-medium text-[#6a6a6a]">No files found</p>
        <p className="text-xs text-[#4a4a4a] text-center max-w-xs leading-relaxed">
          {searchQuery
            ? `No files match "${searchQuery}"`
            : "Drop files into your vault folder and they'll sync automatically."}
        </p>
      </div>
    );
  }

  const shared = {
    query: searchQuery,
    onDelete,
    onRename,
    onOpen,
    onGetPreview,
  };

  if (view === "list") {
    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div
          className="grid gap-2 px-3 py-2 border-b border-[#3e3e42] bg-[#252526] text-[10px] font-semibold uppercase tracking-widest text-[#4a4a4a] shrink-0"
          style={{ gridTemplateColumns: "32px 1fr 90px 72px 110px 72px" }}
        >
          <span />
          <span>Name</span>
          <span>Type</span>
          <span>Size</span>
          <span>Modified</span>
          <span className="text-right">Actions</span>
        </div>
        <ScrollArea className="flex-1">
          <div className="px-2 py-1.5 flex flex-col gap-0.5">
            {files.map((f) => (
              <FileRow key={f.name} file={f} {...shared} />
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
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
      >
        {files.map((f) => (
          <FileCard key={f.name} file={f} {...shared} />
        ))}
      </div>
    </ScrollArea>
  );
}
