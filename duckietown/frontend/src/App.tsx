import { useState, useEffect, useCallback } from "react";
import { wails } from "./lib/wails";
import { SetupScreen } from "./components/setupscreen";
import { MainScreen } from "./components/mainscreen";
import type { FileRecord, WailsFileEvent } from "./types";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

export default function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [isWatching, setIsWatching] = useState(false);

  const loadFiles = useCallback(async () => {
    try {
      const result = await wails.listFiles();
      setFiles((result as FileRecord[]) ?? []);
    } catch (e) {
      toast.error("Failed to load files", { description: String(e) });
    }
  }, []);

  // Init
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      try {
        const path = await wails.getVaultPath();
        if (path) {
          setVaultPath(path);
          await loadFiles();
          setIsWatching(true);
        }
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [loadFiles]);

  // Wails events
  useEffect(() => {
    wails.on("file-uploaded", (name: string) => {
      setSyncing(false);
      toast.dismiss("sync");
      toast.success("Synced", { description: name });
      loadFiles();
    });
    wails.on("file-changed", (e: WailsFileEvent) => {
      setSyncing(true);
      toast.loading(`Syncing ${e.file_name}…`, { id: "sync" });
    });
    wails.on("upload-error", (e: { file: string; error: string }) => {
      setSyncing(false);
      toast.dismiss("sync");
      toast.error("Upload failed", { description: e.file });
    });
    wails.on("watcher-ready", () => {
      setIsWatching(true);
      toast.success("Duckietown active", {
        description: "Watching for changes",
      });
    });
    return () => {
      wails.off("file-uploaded");
      wails.off("file-changed");
      wails.off("upload-error");
      wails.off("watcher-ready");
    };
  }, [loadFiles]);

  const handleSetup = async () => {
    try {
      const selected = await wails.selectFolder();
      if (!selected) return;
      await wails.setVaultPath(selected);
      setVaultPath(selected);
      setIsWatching(true);
      toast.success("Vault ready!", {
        description: "Drop files in to auto-sync",
      });
      await loadFiles();
    } catch (e) {
      toast.error("Setup failed", { description: String(e) });
    }
  };

  const handleDeleteFile = async (name: string) => {
    try {
      await wails.deleteFile(name);
      toast.info(`Deleted ${name}`);
      setFiles((f) => f.filter((x) => x.name !== name));
    } catch (e) {
      toast.error("Delete failed", { description: String(e) });
    }
  };

  const handleRenameFile = async (oldName: string, newName: string) => {
    try {
      await wails.renameFile(oldName, newName);
      toast.success(`Renamed to ${newName}`);
      await loadFiles();
    } catch (e) {
      toast.error("Rename failed", { description: String(e) });
    }
  };

  const handleOpenFile = async (name: string) => {
    try {
      await wails.openFile(name);
    } catch (e) {
      toast.error("Cannot open file", { description: String(e) });
    }
  };

  const handleGetPreview = useCallback(
    async (name: string): Promise<string> => {
      try {
        return await wails.getFilePreview(name);
      } catch {
        return "";
      }
    },
    [],
  );

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background flex-col gap-3">
        <div className="w-7 h-7 rounded-full border-2 border-border border-t-primary spin" />
        <p className="text-xs text-muted-foreground font-mono">
          Loading Duckietown…
        </p>
      </div>
    );
  }

  return (
    <>
      {!vaultPath ? (
        <SetupScreen onSetup={handleSetup} />
      ) : (
        <MainScreen
          files={files}
          vaultPath={vaultPath}
          isWatching={isWatching}
          syncing={syncing}
          onDelete={handleDeleteFile}
          onRename={handleRenameFile}
          onOpen={handleOpenFile}
          onGetPreview={handleGetPreview}
          onOpenVault={() => wails.openVaultFolder()}
          onRefresh={loadFiles}
        />
      )}
      <Toaster theme="dark" richColors position="bottom-right" />
    </>
  );
}
