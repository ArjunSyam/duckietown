import { useState, useEffect } from "react";
import {
  ChevronRight,
  Home,
  Sparkles,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { wails } from "../lib/wails";

interface Props {
  currentFolder: string;
  onNavigate: (path: string) => void;
  onAskAi: () => void;
  aiPanelOpen: boolean;
}

type IngestState = "idle" | "ingesting" | "done";

export function Topbar({
  currentFolder,
  onNavigate,
  onAskAi,
  aiPanelOpen,
}: Props) {
  const segments = currentFolder ? currentFolder.split("/") : [];

  const [ingestState, setIngestState] = useState<IngestState>("idle");
  const [currentFile, setCurrentFile] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    wails.on("ingest-queued", (data: { total: number }) => {
      setTotal(data.total);
      setRemaining(data.total);
      setIngestState("ingesting");
    });

    wails.on("ingest-start", (data: { file_name: string }) => {
      setCurrentFile(data.file_name);
      setIngestState("ingesting");
    });

    wails.on("ingest-progress", (data: { remaining: number }) => {
      setRemaining(data.remaining);
    });

    wails.on("ingest-done", () => {
      setIngestState("done");
      setCurrentFile("");
      setTimeout(() => {
        setIngestState("idle");
        setTotal(0);
        setRemaining(0);
      }, 4000);
    });

    return () => {
      wails.off("ingest-queued");
      wails.off("ingest-start");
      wails.off("ingest-progress");
      wails.off("ingest-done");
    };
  }, []);

  const completed = total > 0 ? total - remaining : 0;
  const shortName = (name: string) =>
    name.length > 22 ? name.slice(0, 20) + "…" : name;

  return (
    <div className="flex items-center gap-2 px-4 h-11 border-b border-[#3e3e42] bg-[#1e1e1e] shrink-0">
      {/* Breadcrumb — left */}
      <div className="flex items-center gap-1 text-xs min-w-0 flex-1">
        <button
          onClick={() => onNavigate("")}
          className="flex items-center gap-1 text-[#6a6a6a] hover:text-[#d4d4d4] transition-colors shrink-0"
        >
          <Home size={11} />
          <span>Vault</span>
        </button>
        {segments.map((seg, i) => {
          const path = segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={path} className="flex items-center gap-1 min-w-0">
              <ChevronRight size={10} className="text-[#3e3e42] shrink-0" />
              <button
                onClick={() => onNavigate(path)}
                className={`truncate transition-colors ${
                  isLast
                    ? "text-[#d4d4d4] font-medium cursor-default max-w-[160px]"
                    : "text-[#6a6a6a] hover:text-[#d4d4d4] max-w-[120px]"
                }`}
              >
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      {/* Ingest status — center */}
      <div className="flex items-center justify-center flex-1">
        {ingestState === "ingesting" && (
          <div className="flex items-center gap-1.5 text-[10px] text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-3 py-1">
            <Loader2 size={10} className="animate-spin shrink-0" />
            <span className="font-mono whitespace-nowrap">
              {total > 1
                ? `Indexing ${completed + 1}/${total} · ${shortName(currentFile)}`
                : `Indexing · ${shortName(currentFile)}`}
            </span>
          </div>
        )}
        {ingestState === "done" && (
          <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-3 py-1">
            <CheckCircle2 size={10} className="shrink-0" />
            <span className="font-mono whitespace-nowrap">
              {total > 1 ? `${total} files indexed` : "File indexed"}
            </span>
          </div>
        )}
      </div>

      {/* Ask AI button — right */}
      <div className="flex items-center justify-end flex-1">
        <button
          onClick={onAskAi}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-all
            ${
              aiPanelOpen
                ? "border-indigo-500/50 text-indigo-400 bg-indigo-500/10"
                : "border-[#3e3e42] text-[#6a6a6a] hover:text-[#d4d4d4] hover:border-[#505050]"
            }`}
        >
          <Sparkles size={12} />
          Ask AI
        </button>
      </div>
    </div>
  );
}
