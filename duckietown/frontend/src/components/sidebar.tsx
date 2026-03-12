import {
  Files,
  Image,
  FileText,
  Video,
  Music,
  Package,
  FolderOpen,
  Wifi,
  WifiOff,
  Loader2,
  Cloud,
  LayoutGrid,
  List,
  RefreshCw,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FileRecord, FileTypeFilter, ViewMode } from "../types";
import { formatBytes } from "../lib/utils";

const NAV: { id: FileTypeFilter; label: string; icon: React.ReactNode }[] = [
  { id: "all", label: "All Files", icon: <Files size={14} /> },
  { id: "images", label: "Images", icon: <Image size={14} /> },
  { id: "documents", label: "Documents", icon: <FileText size={14} /> },
  { id: "videos", label: "Videos", icon: <Video size={14} /> },
  { id: "audio", label: "Audio", icon: <Music size={14} /> },
  { id: "other", label: "Other", icon: <Package size={14} /> },
];

function countByType(files: FileRecord[], type: FileTypeFilter): number {
  if (type === "all") return files.length;
  if (type === "images")
    return files.filter((f) => f.mime_type.startsWith("image/")).length;
  if (type === "documents")
    return files.filter(
      (f) =>
        f.mime_type.includes("pdf") ||
        f.mime_type.includes("document") ||
        f.mime_type.includes("text"),
    ).length;
  if (type === "videos")
    return files.filter((f) => f.mime_type.startsWith("video/")).length;
  if (type === "audio")
    return files.filter((f) => f.mime_type.startsWith("audio/")).length;
  return files.filter(
    (f) =>
      !f.mime_type.startsWith("image/") &&
      !f.mime_type.startsWith("video/") &&
      !f.mime_type.startsWith("audio/") &&
      !f.mime_type.includes("pdf") &&
      !f.mime_type.includes("document") &&
      !f.mime_type.includes("text"),
  ).length;
}

interface Props {
  files: FileRecord[];
  selectedType: FileTypeFilter;
  onSelectType: (t: FileTypeFilter) => void;
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  isWatching: boolean;
  syncing: boolean;
  vaultPath: string;
  onOpenVault: () => void;
  onRefresh: () => void;
}

export function Sidebar({
  files,
  selectedType,
  onSelectType,
  view,
  onViewChange,
  isWatching,
  syncing,
  vaultPath,
  onOpenVault,
  onRefresh,
}: Props) {
  const folderName = vaultPath.split(/[\\/]/).pop() ?? "Vault";
  const totalSize = files.reduce((acc, f) => acc + (f.size ?? 0), 0);
  const storagePercent = Math.min((totalSize / (10 * 1e9)) * 100, 100);

  return (
    <TooltipProvider>
      <aside className="w-[220px] min-w-[220px] flex flex-col border-r border-[#3e3e42] bg-[#252526]">
        {/* Brand — drag region */}
        <div className="drag-region flex items-center justify-between px-4 py-3 border-b border-[#3e3e42]">
          <div className="flex items-center gap-2.5 no-drag">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Cloud size={14} />
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Duckietown
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6 no-drag"
                onClick={onRefresh}
              >
                <RefreshCw size={12} className="text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>

        {/* Vault chip */}
        <div className="px-2.5 pt-2.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenVault}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[#2d2d30] border border-[#3e3e42] text-[#6a6a6a] hover:text-[#d4d4d4] hover:border-[#505050] transition-colors text-xs font-mono overflow-hidden"
              >
                <FolderOpen size={12} className="shrink-0" />
                <span className="truncate">{folderName}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs font-mono">
              {vaultPath}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Nav */}
        <ScrollArea className="flex-1 px-2 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#4a4a4a] px-2 pb-1.5 pt-1">
            Browse
          </p>
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => onSelectType(item.id)}
              className={`w-full flex items-center gap-2 px-2 py-[7px] rounded-sm transition-colors mb-0.5 text-left
                ${
                  selectedType === item.id
                    ? "nav-active font-medium"
                    : "text-[#9d9d9d] hover:text-[#d4d4d4] hover:bg-[#2d2d30]"
                }`}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="flex-1 text-xs">{item.label}</span>
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded-sm
                ${selectedType === item.id ? "bg-indigo-500/15 text-indigo-300" : "bg-[#2d2d30] text-[#4a4a4a]"}`}
              >
                {countByType(files, item.id)}
              </span>
            </button>
          ))}

          {/* View toggle */}
          <p className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#4a4a4a] px-2 pb-1.5 pt-4">
            View
          </p>
          <div className="flex gap-1 px-1">
            <Button
              variant={view === "grid" ? "secondary" : "ghost"}
              size="sm"
              className="flex-1 h-7 text-xs gap-1.5"
              onClick={() => onViewChange("grid")}
            >
              <LayoutGrid size={11} /> Grid
            </Button>
            <Button
              variant={view === "list" ? "secondary" : "ghost"}
              size="sm"
              className="flex-1 h-7 text-xs gap-1.5"
              onClick={() => onViewChange("list")}
            >
              <List size={11} /> List
            </Button>
          </div>
        </ScrollArea>

        <Separator className="bg-[#3e3e42]" />

        {/* Footer */}
        <div className="px-3 py-3 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-[#6a6a6a]">
            {syncing ? (
              <Loader2 size={12} className="spin text-yellow-400 shrink-0" />
            ) : isWatching ? (
              <Wifi size={12} className="text-emerald-400 shrink-0" />
            ) : (
              <WifiOff size={12} className="shrink-0" />
            )}
            <span className="text-xs">
              {syncing
                ? "Syncing…"
                : isWatching
                  ? "Live sync on"
                  : "Not syncing"}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between">
              <span className="text-[10px] uppercase tracking-[1px] text-[#4a4a4a]">
                Storage
              </span>
              <span className="text-[10px] font-mono text-[#6a6a6a]">
                {formatBytes(totalSize)}
              </span>
            </div>
            <Progress value={storagePercent} className="h-[3px]" />
          </div>
        </div>
      </aside>
    </TooltipProvider>
  );
}
