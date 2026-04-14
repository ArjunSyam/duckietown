import { useRef, useEffect, useState } from "react";
import {
  Sparkles,
  ChevronUp,
  ChevronDown,
  X,
  CornerDownLeft,
  Search,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { wails } from "../lib/wails";
import type { SearchResult } from "../types";

interface Props {
  open: boolean;
  onToggle: () => void;
  query: string;
  onSearch: (q: string) => void;
  onAiSearch: (results: SearchResult[]) => void;
  aiResultCount: number;
}

export function SearchBar({
  open,
  onToggle,
  query,
  onSearch,
  onAiSearch,
  aiResultCount,
}: Props) {
  const [draft, setDraft] = useState(query);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isActive = query.trim().length > 0;

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!query) setAiMode(false);
  }, [query]);

  const runAiSearch = async (q: string) => {
    if (!q.trim()) return;
    setAiLoading(true);
    try {
      const results: SearchResult[] = await wails.semanticSearch(q.trim(), 50);
      setAiMode(true);
      onSearch(q.trim());
      onAiSearch(results);
    } catch (e) {
      console.error("AI search failed:", e);
    } finally {
      setAiLoading(false);
    }
  };

  const clear = () => {
    setDraft("");
    setAiMode(false);
    onSearch("");
    onAiSearch([]);
  };

  const statusText = () => {
    if (aiLoading) return "Searching…";
    if (aiMode)
      return `"${query}" · ${aiResultCount} files ranked by relevance`;
    if (isActive) return `"${query}"`;
    return "Ask AI to find files…";
  };

  return (
    <div
      className={`border-t border-[#3e3e42] bg-[#252526] transition-all duration-200 shrink-0 ${
        open ? "search-bar-expanded" : "search-bar-collapsed"
      } overflow-hidden`}
    >
      {/* Toggle row */}
      <div className="flex items-center gap-2 px-4 h-12">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 text-xs text-[#6a6a6a] hover:text-[#d4d4d4] transition-colors"
        >
          {aiLoading ? (
            <Loader2 size={14} className="text-indigo-400 animate-spin" />
          ) : (
            <Sparkles
              size={14}
              className={isActive || aiMode ? "text-indigo-400" : ""}
            />
          )}
          <span className={isActive || aiMode ? "text-indigo-300" : ""}>
            {statusText()}
          </span>
          {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>

        {isActive && (
          <button
            onClick={clear}
            className="ml-1 text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors"
          >
            <X size={12} />
          </button>
        )}

        <div className="ml-auto flex items-center gap-1 text-[10px] text-[#3a3a3a] font-mono">
          <kbd className="border border-[#3e3e42] rounded px-1 py-0.5">↑</kbd>
          <span>to expand</span>
        </div>
      </div>

      {/* Expanded area */}
      {open && (
        <>
          <Separator className="bg-[#3e3e42]" />

          <div className="flex items-center gap-3 px-4 py-3">
            <Search size={15} className="text-[#4a4a4a] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                // If user edits after an AI search, clear old results
                if (aiMode) {
                  setAiMode(false);
                  onAiSearch([]);
                  onSearch("");
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") runAiSearch(draft);
                if (e.key === "Escape") {
                  clear();
                  onToggle();
                }
              }}
              placeholder="Describe what you're looking for and press Enter…"
              className="flex-1 bg-transparent border-none outline-none text-sm text-[#d4d4d4] placeholder:text-[#3a3a3a]"
            />
            {draft && (
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6 shrink-0"
                onClick={clear}
              >
                <X size={12} />
              </Button>
            )}
            <Button
              variant={draft ? "default" : "ghost"}
              size="icon"
              className={`w-7 h-7 shrink-0 transition-all ${!draft && "opacity-20"}`}
              onClick={() => runAiSearch(draft)}
              disabled={!draft || aiLoading}
            >
              {aiLoading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <CornerDownLeft size={13} />
              )}
            </Button>
          </div>

          <div className="px-4 pb-3">
            <p className="text-[10px] text-[#3a3a3a] flex items-center gap-1.5">
              {aiLoading ? (
                <>
                  <Loader2 size={10} className="text-indigo-400 animate-spin" />
                  Searching across file contents…
                </>
              ) : aiMode ? (
                <>
                  <Sparkles size={10} className="text-indigo-400" />
                  Files ranked by semantic similarity — press Enter to re-search
                </>
              ) : (
                <>
                  <Sparkles size={10} className="text-indigo-500/50" />
                  Searches inside file contents, not just filenames
                </>
              )}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
