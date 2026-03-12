import { useState } from "react";
import { Sidebar } from "./sidebar";
import { FileArea } from "./filearea";
import { SearchBar } from "./searchbar";
import type { FileRecord, FileTypeFilter, ViewMode } from "../types";

interface Props {
  files: FileRecord[];
  vaultPath: string;
  isWatching: boolean;
  syncing: boolean;
  onDelete: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onOpen: (name: string) => void;
  onGetPreview: (name: string) => Promise<string>;
  onOpenVault: () => void;
  onRefresh: () => void;
}

export function MainScreen({
  files,
  vaultPath,
  isWatching,
  syncing,
  onDelete,
  onRename,
  onOpen,
  onGetPreview,
  onOpenVault,
  onRefresh,
}: Props) {
  const [selectedType, setSelectedType] = useState<FileTypeFilter>("all");
  const [view, setView] = useState<ViewMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const filteredFiles = files.filter((f) => {
    const q = searchQuery.toLowerCase().trim();
    const matchSearch = !q || f.name.toLowerCase().includes(q);
    const matchType =
      selectedType === "all" ||
      (selectedType === "images" && f.mime_type.startsWith("image/")) ||
      (selectedType === "documents" &&
        (f.mime_type.includes("pdf") ||
          f.mime_type.includes("document") ||
          f.mime_type.includes("text"))) ||
      (selectedType === "videos" && f.mime_type.startsWith("video/")) ||
      (selectedType === "audio" && f.mime_type.startsWith("audio/")) ||
      (selectedType === "other" &&
        !f.mime_type.startsWith("image/") &&
        !f.mime_type.startsWith("video/") &&
        !f.mime_type.startsWith("audio/") &&
        !f.mime_type.includes("pdf") &&
        !f.mime_type.includes("document") &&
        !f.mime_type.includes("text"));
    return matchSearch && matchType;
  });

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
      />
      <div className="flex flex-col flex-1 overflow-hidden">
        <FileArea
          files={filteredFiles}
          view={view}
          searchQuery={searchQuery}
          onDelete={onDelete}
          onRename={onRename}
          onOpen={onOpen}
          onGetPreview={onGetPreview}
        />
        <SearchBar
          open={searchOpen}
          onToggle={() => setSearchOpen((v) => !v)}
          query={searchQuery}
          onSearch={setSearchQuery}
          resultCount={filteredFiles.length}
          totalCount={files.length}
        />
      </div>
    </div>
  );
}
