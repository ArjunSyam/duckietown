import { useState, useEffect } from "react";
import { ChevronRight, Home, Brain, CheckCircle } from "lucide-react";
import { wails } from "../lib/wails";

interface Props {
  currentFolder: string;
  onNavigate: (path: string) => void;
}

type IngestState = "idle" | "ingesting" | "done";

export function Breadcrumb({ currentFolder, onNavigate }: Props) {
  const segments = currentFolder ? currentFolder.split("/") : [];

  const [ingestState, setIngestState] = useState<IngestState>("idle");
  const [currentFile, setCurrentFile] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    // How many files are queued total
    wails.on("ingest-queued", (data: { total: number }) => {
      setTotal(data.total);
      setRemaining(data.total);
      setIngestState("ingesting");
    });

    // A file just started ingesting
    wails.on("ingest-start", (data: { file_name: string; pending: string }) => {
      setCurrentFile(data.file_name);
      setIngestState("ingesting");
    });

    // A file finished ingesting
    wails.on(
      "ingest-progress",
      (data: { file_name: string; remaining: number }) => {
        setRemaining(data.remaining);
        if (data.remaining === 0) {
          // Will transition to done via ingest-done
        }
      },
    );

    // All done
    wails.on("ingest-done", () => {
      setIngestState("done");
      setCurrentFile("");
      setRemaining(0);
      // Auto-clear the "done" state after 4 seconds
      setTimeout(() => setIngestState("idle"), 4000);
    });

    // New single file added while watching
    wails.on("file-uploaded", (name: string) => {
      if (name !== "sync-complete" && name !== "initial-scan") {
        // A new file was uploaded — ingest will be queued shortly
        // ingest-start will handle showing it
      }
    });

    return () => {
      wails.off("ingest-queued");
      wails.off("ingest-start");
      wails.off("ingest-progress");
      wails.off("ingest-done");
    };
  }, []);

  const completed = total > 0 ? total - remaining : 0;

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-[#3e3e42] bg-[#1e1e1e] text-xs shrink-0">
      {/* Path navigation */}
      <button
        onClick={() => onNavigate("")}
        className="flex items-center gap-1 text-[#6a6a6a] hover:text-[#d4d4d4] transition-colors"
      >
        <Home size={11} />
        <span>Vault</span>
      </button>

      {segments.map((seg, i) => {
        const path = segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        return (
          <span key={path} className="flex items-center gap-1">
            <ChevronRight size={10} className="text-[#3e3e42]" />
            <button
              onClick={() => onNavigate(path)}
              className={`transition-colors ${
                isLast
                  ? "text-[#d4d4d4] font-medium cursor-default"
                  : "text-[#6a6a6a] hover:text-[#d4d4d4]"
              }`}
            >
              {seg}
            </button>
          </span>
        );
      })}

      {/* Ingest status — right side */}
      <div className="ml-auto flex items-center gap-1.5">
        {ingestState === "ingesting" && (
          <div className="flex items-center gap-1.5 text-[10px] text-indigo-400">
            <Brain size={11} className="animate-pulse shrink-0" />
            <span className="font-mono">
              {total > 1
                ? `Ingesting ${completed}/${total} · ${currentFile.length > 20 ? currentFile.slice(0, 18) + "…" : currentFile}`
                : `Ingesting · ${currentFile.length > 24 ? currentFile.slice(0, 22) + "…" : currentFile}`}
            </span>
          </div>
        )}

        {ingestState === "done" && (
          <div className="flex items-center gap-1.5 text-[10px] text-emerald-400">
            <CheckCircle size={11} className="shrink-0" />
            <span className="font-mono">
              {total > 1 ? `${total} files indexed` : "Indexed"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
