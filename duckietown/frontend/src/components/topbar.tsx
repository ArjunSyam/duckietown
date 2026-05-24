import { useState, useEffect, useRef } from "react";
import {
  ChevronRight,
  Home,
  Sparkles,
  Loader2,
  CheckCircle2,
  Database,
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
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  // Persist the last completed count so it always shows after done
  const lastTotalRef = useRef(0);

  useEffect(() => {
    wails.on("ingest-queued", (data: { total: number }) => {
      setTotal(data.total);
      setCompleted(0);
      setIngestState("ingesting");
    });

    wails.on("ingest-start", (data: { file_name: string }) => {
      setCurrentFile(data.file_name);
      setIngestState("ingesting");
      // If a single file arrives (watcher) with no prior queue event, total = 1
      setTotal((t) => (t === 0 ? 1 : t));
    });

    wails.on(
      "ingest-progress",
      (data: { file_name: string; remaining: number }) => {
        // completed = total - remaining
        setTotal((t) => {
          const done = t - data.remaining;
          setCompleted(done);
          return t;
        });
        setCurrentFile(data.file_name);
      },
    );

    wails.on("ingest-done", () => {
      // Snapshot the total for the done pill before resetting
      setTotal((t) => {
        lastTotalRef.current = t;
        setCompleted(t);
        return t;
      });
      setIngestState("done");
      setCurrentFile("");
      // NO auto-clear — stays as "done" permanently until next ingest
    });

    // When a new ingest batch starts, reset done state
    wails.on("ingest-queued", () => {
      setIngestState("ingesting");
    });

    return () => {
      wails.off("ingest-queued");
      wails.off("ingest-start");
      wails.off("ingest-progress");
      wails.off("ingest-done");
    };
  }, []);

  const shortName = (name: string) =>
    name.length > 24 ? name.slice(0, 22) + "…" : name;

  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="flex items-center gap-2 px-4 h-11 border-b border-[#3e3e42] bg-[#1e1e1e] shrink-0">
      {/* ── Breadcrumb — left ─────────────────────────── */}
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

      {/* ── Ingest status — centre ────────────────────── */}
      <div className="flex items-center justify-center flex-1 min-w-0">
        {ingestState === "ingesting" && (
          <div className="flex flex-col items-center gap-0.5 w-full max-w-[280px]">
            {/* Top row: spinner + label */}
            <div className="flex items-center gap-1.5 text-[10px] text-indigo-400">
              <Loader2 size={10} className="animate-spin shrink-0" />
              <span className="font-mono whitespace-nowrap truncate">
                {total > 1
                  ? `Indexing ${completed}/${total} · ${shortName(currentFile)}`
                  : `Indexing · ${shortName(currentFile)}`}
              </span>
            </div>
            {/* Progress bar (only when we know the total) */}
            {total > 1 && (
              <div className="w-full h-[3px] bg-[#2d2d2d] rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            )}
          </div>
        )}

        {ingestState === "done" && (
          <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-3 py-1">
            <CheckCircle2 size={10} className="shrink-0" />
            <span className="font-mono whitespace-nowrap">
              All files indexed
            </span>
          </div>
        )}

        {ingestState === "idle" && (
          <div className="flex items-center gap-1.5 text-[10px] text-[#3a3a3a]">
            <Database size={10} className="shrink-0" />
            <span className="font-mono">Vault ready</span>
          </div>
        )}
      </div>

      {/* ── Ask AI button — right ─────────────────────── */}
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
