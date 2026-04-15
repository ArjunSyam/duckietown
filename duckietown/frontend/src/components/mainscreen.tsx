import { useState, useEffect, useCallback } from "react";
import { Sparkles } from "lucide-react";
import { Sidebar } from "./sidebar";
import { FileArea } from "./filearea";
import { SearchBar } from "./searchbar";
import { AIPanel } from "./aipanel";
import { Breadcrumb } from "./breadcrumbs";
import { wails } from "../lib/wails";
import { toast } from "sonner";
import type {
  FileRecord,
  FileTypeFilter,
  ViewMode,
  SearchResult,
  FolderRecord,
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

  // Folder state
  const [currentFolder, setCurrentFolder] = useState<string>("");
  const [folders, setFolders] = useState<FolderRecord[]>([]);

  // AI panel
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiTargetFile, setAiTargetFile] = useState<string | null>(null);
  const [aiSessionKey, setAiSessionKey] = useState(0);

  const loadFolders = useCallback(async () => {
    try {
      const result = await wails.listFolders();
      setFolders((result as unknown as FolderRecord[]) ?? []);
    } catch (e) {
      console.error("Failed to load folders", e);
    }
  }, []);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  // Listen for folder/file events that require folder refresh
  useEffect(() => {
    wails.on("folder-created", () => {
      loadFolders();
      onRefresh();
    });
    wails.on("folder-deleted", () => {
      loadFolders();
      onRefresh();
    });
    wails.on("file-moved", () => {
      onRefresh();
    });
    return () => {
      wails.off("folder-created");
      wails.off("folder-deleted");
      wails.off("file-moved");
    };
  }, [loadFolders, onRefresh]);

  // Files visible in current folder (exact match — not recursive)
  const folderFiles =
    currentFolder === ""
      ? files // root shows all files with no folder_path
          .filter((f) => f.folder_path === "" || f.folder_path === null)
      : files.filter((f) => f.folder_path === currentFolder);

  // Apply type filter on top of folder filter
  const typeFiltered = folderFiles.filter((f) => {
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

  // AI results override order when active (search across all files, not just current folder)
  const displayFiles =
    aiResults.length > 0
      ? (aiResults
          .map((r) => files.find((f) => f.name === r.file_name))
          .filter(Boolean) as FileRecord[])
      : typeFiltered;

  // ── Folder handlers ──────────────────────────────────────────────────────────

  const handleCreateFolder = async (parentPath: string, name: string) => {
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    try {
      await wails.createFolder(fullPath);
      toast.success(`Folder "${name}" created`);
      await loadFolders();
    } catch (e) {
      toast.error("Failed to create folder", { description: String(e) });
    }
  };

  const handleDeleteFolder = async (path: string) => {
    try {
      await wails.deleteFolder(path);
      toast.info(`Folder deleted`);
      if (currentFolder === path || currentFolder.startsWith(path + "/")) {
        setCurrentFolder("");
      }
      await loadFolders();
      onRefresh();
    } catch (e) {
      toast.error("Failed to delete folder", { description: String(e) });
    }
  };

  const handleDropFileToFolder = async (
    fileName: string,
    targetFolderPath: string,
  ) => {
    try {
      await wails.moveFileToFolder(fileName, targetFolderPath);
      toast.success(`Moved ${fileName}`, {
        description: targetFolderPath ? `→ ${targetFolderPath}` : "→ Root",
      });
      onRefresh();
    } catch (e) {
      toast.error("Move failed", { description: String(e) });
    }
  };

  // ── AI handlers ──────────────────────────────────────────────────────────────

  const openAiPanel = (targetFile: string | null) => {
    setAiTargetFile(targetFile);
    setAiPanelOpen(true);
    setAiSessionKey((k) => k + 1);
  };

  const closeAiPanel = () => {
    setAiPanelOpen(false);
    setAiTargetFile(null);
  };

  // ── Organise handler — triggered from AIPanel ────────────────────────────────
  // AIPanel can emit "organise" events with {query, folderName}
  useEffect(() => {
    wails.on("organise-complete", (result: unknown) => {
      const r = result as {
        folder_name: string;
        files: string[];
        created: boolean;
      };
      if (r.created) {
        toast.success(`Organised ${r.files.length} files`, {
          description: `Created folder "${r.folder_name}"`,
        });
        loadFolders();
        onRefresh();
      }
    });
    return () => wails.off("organise-complete");
  }, [loadFolders, onRefresh]);

  return (
    <div className="flex h-screen overflow-hidden bg-[#1e1e1e] text-[#d4d4d4]">
      <Sidebar
        files={files}
        folders={folders}
        currentFolder={currentFolder}
        selectedType={selectedType}
        onSelectType={setSelectedType}
        onSelectFolder={(path) => {
          setCurrentFolder(path);
          setAiResults([]);
          setSearchQuery("");
        }}
        onCreateFolder={handleCreateFolder}
        onDeleteFolder={handleDeleteFolder}
        onDropFileToFolder={handleDropFileToFolder}
        view={view}
        onViewChange={setView}
        isWatching={isWatching}
        syncing={syncing}
        vaultPath={vaultPath}
        onOpenVault={onOpenVault}
        onRefresh={() => {
          onRefresh();
          loadFolders();
        }}
        onSignOut={onSignOut}
        userEmail={user?.email ?? ""}
      />

      <div className="flex flex-1 overflow-hidden min-w-0">
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          {/* Breadcrumb */}
          <Breadcrumb
            currentFolder={currentFolder}
            onNavigate={(path) => {
              setCurrentFolder(path);
              setAiResults([]);
              setSearchQuery("");
            }}
          />

          {/* Top bar */}
          <div className="flex items-center justify-end px-4 py-2 border-b border-[#3e3e42] bg-[#1e1e1e] shrink-0">
            <button
              onClick={() => openAiPanel(null)}
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

          {/* AI results banner */}
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
            currentFolder={currentFolder}
            onDelete={onDelete}
            onRename={onRename}
            onOpen={onOpen}
            onGetPreview={onGetPreview}
            onAskAi={(fileName) => openAiPanel(fileName)}
            onMoveToFolder={handleDropFileToFolder}
            onNavigateFolder={setCurrentFolder}
            folders={folders}
          />

          <SearchBar
            open={searchOpen}
            onToggle={() => setSearchOpen((v) => !v)}
            query={searchQuery}
            onSearch={(q) => {
              setSearchQuery(q);
              if (!q) setAiResults([]);
            }}
            onAiSearch={setAiResults}
            aiResultCount={aiResults.length}
          />
        </div>

        {aiPanelOpen && (
          <AIPanel
            key={aiSessionKey}
            open={aiPanelOpen}
            onClose={closeAiPanel}
            targetFile={aiTargetFile}
            sessionKey={aiSessionKey}
            currentFolder={currentFolder}
          />
        )}
      </div>
    </div>
  );
}
