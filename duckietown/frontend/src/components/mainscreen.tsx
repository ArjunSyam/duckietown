import { useState, useEffect, useCallback } from "react";
import { Sparkles } from "lucide-react";
import { Sidebar } from "./sidebar";
import { FileArea } from "./filearea";
import { SearchBar } from "./searchbar";
import { AIPanel } from "./aipanel";
import { Topbar } from "./topbar";
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

  const [currentFolder, setCurrentFolder] = useState<string>("");
  const [folders, setFolders] = useState<FolderRecord[]>([]);

  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiTargetFile, setAiTargetFile] = useState<string | null>(null);
  const [aiSessionKey, setAiSessionKey] = useState(0);

  // loadFolders — plain async function, called from event handlers and imperative code
  const loadFolders = useCallback(async () => {
    try {
      const result = await wails.listFolders();
      setFolders((result as unknown as FolderRecord[]) ?? []);
    } catch (e) {
      console.error("Failed to load folders", e);
    }
  }, []);

  // Initial load — runs once, async inside effect body is fine with cancelled guard
  useEffect(() => {
    let cancelled = false;
    wails
      .listFolders()
      .then((result) => {
        if (!cancelled) setFolders((result as unknown as FolderRecord[]) ?? []);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wails events — setState called inside callbacks, not directly in effect body
  useEffect(() => {
    const refresh = () => {
      void loadFolders();
      onRefresh();
    };
    wails.on("folder-created", refresh);
    wails.on("folder-deleted", refresh);
    wails.on("file-moved", () => {
      onRefresh();
    });
    wails.on("organise-complete", (result: unknown) => {
      const r = result as {
        folder_name: string;
        files: string[];
        created: boolean;
      };
      if (r.created) {
        toast.success(`Organised ${r.files?.length ?? 0} files`, {
          description: `Created folder "${r.folder_name}"`,
        });
        void loadFolders();
        onRefresh();
      }
    });
    return () => {
      wails.off("folder-created");
      wails.off("folder-deleted");
      wails.off("file-moved");
      wails.off("organise-complete");
    };
  }, [loadFolders, onRefresh]);

  // Files in current folder only
  const folderFiles =
    currentFolder === ""
      ? files.filter((f) => !f.folder_path || f.folder_path === "")
      : files.filter((f) => f.folder_path === currentFolder);

  // Apply type filter
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

  // AI results override order when active
  const displayFiles =
    aiResults.length > 0
      ? (aiResults
          .map((r) => files.find((f) => f.name === r.file_name))
          .filter(Boolean) as FileRecord[])
      : typeFiltered;

  // ── Folder handlers ──────────────────────────────────

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
      toast.info("Folder deleted");
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

  // ── AI panel handlers ────────────────────────────────

  const openAiPanel = (targetFile: string | null) => {
    setAiTargetFile(targetFile);
    setAiPanelOpen(true);
    setAiSessionKey((k) => k + 1);
  };

  const closeAiPanel = () => {
    setAiPanelOpen(false);
    setAiTargetFile(null);
  };

  const navigateFolder = (path: string) => {
    setCurrentFolder(path);
    setAiResults([]);
    setSearchQuery("");
    setSelectedType("all");
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#1e1e1e] text-[#d4d4d4]">
      <Sidebar
        files={files}
        folders={folders}
        currentFolder={currentFolder}
        selectedType={selectedType}
        onSelectType={setSelectedType}
        onSelectFolder={navigateFolder}
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
          void loadFolders();
        }}
        onSignOut={onSignOut}
        userEmail={user?.email ?? ""}
      />

      <div className="flex flex-1 overflow-hidden min-w-0">
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          {/* Combined topbar: breadcrumb + ingest status + Ask AI */}
          <Topbar
            currentFolder={currentFolder}
            onNavigate={navigateFolder}
            onAskAi={() => openAiPanel(null)}
            aiPanelOpen={aiPanelOpen}
          />

          {/* AI search results banner */}
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
            folders={folders}
            onDelete={onDelete}
            onRename={onRename}
            onOpen={onOpen}
            onGetPreview={onGetPreview}
            onAskAi={openAiPanel}
            onMoveToFolder={handleDropFileToFolder}
            onNavigateFolder={navigateFolder}
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
