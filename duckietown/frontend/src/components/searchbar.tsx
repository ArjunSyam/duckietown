import { useRef, useEffect, useState } from "react";
import {
  Sparkles,
  ChevronUp,
  ChevronDown,
  X,
  CornerDownLeft,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const SUGGESTIONS = [
  "Show PDFs",
  "Find images",
  "Audio files",
  "Spreadsheets",
  "Recent videos",
];

interface Props {
  open: boolean;
  onToggle: () => void;
  query: string;
  onSearch: (q: string) => void;
  resultCount: number;
  totalCount: number;
}

export function SearchBar({
  open,
  onToggle,
  query,
  onSearch,
  resultCount,
  totalCount,
}: Props) {
  const [draft, setDraft] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const isActive = query.trim().length > 0;

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const submit = () => onSearch(draft.trim());
  const clear = () => {
    setDraft("");
    onSearch("");
  };

  return (
    <div
      className={`border-t border-[#3e3e42] bg-[#252526] transition-all duration-200 shrink-0 ${open ? "search-bar-expanded" : "search-bar-collapsed"} overflow-hidden`}
    >
      {/* Toggle row — always visible */}
      <div className="flex items-center gap-2 px-4 h-12">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 text-xs text-[#6a6a6a] hover:text-[#d4d4d4] transition-colors"
        >
          <Sparkles size={14} className={isActive ? "text-indigo-400" : ""} />
          <span className={isActive ? "text-indigo-300" : ""}>
            {isActive
              ? `"${query}" · ${resultCount} of ${totalCount} files`
              : "Search files…"}
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

          {/* Input */}
          <div className="flex items-center gap-3 px-4 py-3">
            <Search size={15} className="text-[#4a4a4a] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                onSearch(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") {
                  clear();
                  onToggle();
                }
              }}
              placeholder="Type a filename to filter… e.g. 'invoice' or 'report'"
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
              onClick={submit}
              disabled={!draft}
            >
              <CornerDownLeft size={13} />
            </Button>
          </div>

          {/* Suggestions */}
          <div className="flex items-center gap-2 px-4 pb-3 flex-wrap">
            <span className="text-[10px] text-[#4a4a4a] uppercase tracking-wider shrink-0">
              Try:
            </span>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setDraft(s);
                  onSearch(s);
                }}
                className="text-[11px] text-[#6a6a6a] hover:text-[#d4d4d4] bg-[#2d2d30] hover:bg-[#3e3e42] border border-[#3e3e42] px-2.5 py-1 rounded-full transition-colors"
              >
                {s}
              </button>
            ))}
          </div>

          {/* AI note */}
          <div className="px-4 pb-3">
            <p className="text-[10px] text-[#3a3a3a] flex items-center gap-1.5">
              <Sparkles size={10} className="text-indigo-500/50" />
              AI semantic search coming soon — currently filters by filename
            </p>
          </div>
        </>
      )}
    </div>
  );
}
