import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Sidebar } from "./sidebar";
import { FileArea } from "./filearea";
import { SearchBar } from "./searchbar";
import { AIPanel } from "./aipanel";
import type {
  FileRecord,
  FileTypeFilter,
  ViewMode,
  SearchResult,
} from "../types";

interface User {
  user_id: string;
  email: string;
}

interface Props {
  files: FileRecord[];
  vaultPath: string;
  isWatching: boolean;
  syncing: boolean;
  user: User | null;
  onDelete: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onOpen: (name: string) => void;
  onGetPreview: (name: string) => Promise<string>;
  onOpenVault: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
}

export function MainScreen({
  files,
  vaultPath,
  isWatching,
  syncing,
  user,
  onDelete,
  onRename,
  onOpen,
  onGetPreview,
  onOpenVault,
  onRefresh,
  onSignOut,
}: Props) {
  const [selectedType, setSelectedType] = useState<FileTypeFilter>("all");
  const [view, setView] = useState<ViewMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiResults, setAiResults] = useState<SearchResult[]>([]);

  // AI panel state
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  // If set, panel opens in "summarise this file" mode
  const [aiTargetFile, setAiTargetFile] = useState<string | null>(null);

  // Type filter
  const typeFiltered = files.filter((f) => {
    return (
      selectedType === "all" ||
      (selectedType === "images" && f.mime_type.startsWith("image/")) ||
      (selectedType === "documents" &&
        (f.mime_type.includes("pdf") ||
          f.mime_type.includes("document") ||
          f.mime_type.includes("text") ||
          f.mime_type.includes("wordprocessingml") ||
          f.mime_type.includes("msword"))) ||
      (selectedType === "videos" && f.mime_type.startsWith("video/")) ||
      (selectedType === "audio" && f.mime_type.startsWith("audio/")) ||
      (selectedType === "other" &&
        !f.mime_type.startsWith("image/") &&
        !f.mime_type.startsWith("video/") &&
        !f.mime_type.startsWith("audio/") &&
        !f.mime_type.includes("pdf") &&
        !f.mime_type.includes("document") &&
        !f.mime_type.includes("text") &&
        !f.mime_type.includes("wordprocessingml") &&
        !f.mime_type.includes("msword"))
    );
  });

  // AI results override file order; if no AI results show all type-filtered files
  const displayFiles =
    aiResults.length > 0
      ? (aiResults
          .map((r) => typeFiltered.find((f) => f.name === r.file_name))
          .filter(Boolean) as FileRecord[])
      : typeFiltered;

  const handleAiSearch = (results: SearchResult[]) => {
    setAiResults(results);
  };

  const handleClearSearch = (q: string) => {
    setSearchQuery(q);
    if (!q) setAiResults([]);
  };

  // Called when user right-clicks a file and chooses "Ask AI" / "Summarise"
  const handleAskAiAboutFile = (fileName: string) => {
    setAiTargetFile(fileName);
    setAiPanelOpen(true);
  };

  const handleOpenAiPanel = () => {
    setAiTargetFile(null);
    setAiPanelOpen(true);
  };

  const handleCloseAiPanel = () => {
    setAiPanelOpen(false);
    setAiTargetFile(null);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#1e1e1e] text-[#d4d4d4]">
      <Sidebar
        files={files}
        selectedType={selectedType}
        onSelectType={setSelectedType}
        view={view}
        onViewChange={setView}
        isWatching={isWatching}
        syncing={syncing}
        vaultPath={vaultPath}
        onOpenVault={onOpenVault}
        onRefresh={onRefresh}
        onSignOut={onSignOut}
        userEmail={user?.email ?? ""}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Main content column */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Top bar with Ask AI button */}
          <div className="flex items-center justify-end px-4 py-2 border-b border-[#3e3e42] bg-[#1e1e1e] shrink-0">
            <button
              onClick={handleOpenAiPanel}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors
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

          {/* AI mode banner */}
          {aiResults.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-1.5 bg-indigo-500/10 border-b border-indigo-500/20 shrink-0">
              <Sparkles size={11} className="text-indigo-400" />
              <span className="text-[11px] text-indigo-300">
                {displayFiles.length} files ranked by relevance for &ldquo;
                {searchQuery}&rdquo;
              </span>
              <button
                onClick={() => {
                  setAiResults([]);
                  setSearchQuery("");
                }}
                className="ml-auto text-[10px] text-indigo-400/60 hover:text-indigo-400 transition-colors"
              >
                Clear
              </button>
            </div>
          )}

          <FileArea
            files={displayFiles}
            view={view}
            searchQuery=""
            aiResults={aiResults}
            onDelete={onDelete}
            onRename={onRename}
            onOpen={onOpen}
            onGetPreview={onGetPreview}
            onAskAi={handleAskAiAboutFile}
          />

          <SearchBar
            open={searchOpen}
            onToggle={() => setSearchOpen((v) => !v)}
            query={searchQuery}
            onSearch={handleClearSearch}
            onAiSearch={handleAiSearch}
            aiResultCount={aiResults.length}
          />
        </div>

        {/* AI Panel — slides in from right */}
        <AIPanel
          open={aiPanelOpen}
          onClose={handleCloseAiPanel}
          targetFile={aiTargetFile}
        />
      </div>
    </div>
  );
}
