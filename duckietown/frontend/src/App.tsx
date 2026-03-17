import { useState, useEffect, useCallback } from "react";
import { AuthScreen } from "./components/authscreen";
import { SetupScreen } from "./components/setupscreen";
import { MainScreen } from "./components/mainscreen";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import type { FileRecord, WailsFileEvent } from "./types";
import { wails } from "./lib/wails";

type Screen = "loading" | "auth" | "setup" | "main";

interface User {
  user_id: string;
  email: string;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [isWatching, setIsWatching] = useState(false);
  const [vaultPath, setVaultPath] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      const result = await wails.listFiles();
      setFiles((result as unknown as FileRecord[]) ?? []);
    } catch (e) {
      toast.error("Failed to load files", { description: String(e) });
    }
  }, []);

  // Init — check for existing session
  useEffect(() => {
    const init = async () => {
      try {
        const currentUser = await wails.getCurrentUser();
        if (currentUser) {
          setUser(currentUser as unknown as User);
          const path = await wails.getVaultPath();
          if (path) {
            setVaultPath(path);
            await loadFiles();
            setIsWatching(true);
            setScreen("main");
          } else {
            setScreen("setup");
          }
        } else {
          setScreen("auth");
        }
      } catch {
        setScreen("auth");
      }
    };
    init();
  }, [loadFiles]);

  // Wails events
  useEffect(() => {
    wails.on("auth-success", (data: unknown) => {
      const user = data as User;
      setUser(user);
      toast.success("Signed in!", { description: user.email });
      wails.getVaultPath().then((path) => {
        if (path) {
          setVaultPath(path);
          loadFiles();
          setIsWatching(true);
          setScreen("main");
        } else {
          setScreen("setup");
        }
      });
    });

    wails.on("auth-error", (msg: string) => {
      toast.error("Sign in failed", { description: msg });
      setScreen("auth");
    });

    wails.on("file-uploaded", (name: string) => {
      setSyncing(false);
      toast.dismiss("sync");
      if (name !== "initial-scan") {
        toast.success("Synced", { description: name });
      }
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
      wails.off("auth-success");
      wails.off("auth-error");
      wails.off("file-uploaded");
      wails.off("file-changed");
      wails.off("upload-error");
      wails.off("watcher-ready");
    };
  }, [loadFiles]);

  const handleSignIn = async () => {
    await wails.signInWithGoogle();
  };

  const handleSignOut = async () => {
    await wails.signOut();
    setUser(null);
    setFiles([]);
    setVaultPath(null);
    setIsWatching(false);
    setScreen("auth");
    toast.info("Signed out");
  };

  const handleSetup = async () => {
    try {
      const selected = await wails.selectFolder();
      if (!selected) return;
      await wails.setVaultPath(selected);
      setVaultPath(selected);
      setIsWatching(true);
      toast.success("Vault ready!");
      await loadFiles();
      setScreen("main");
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

  if (screen === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-[#1c1c1c] flex-col gap-3">
        <div className="w-7 h-7 rounded-full border-2 border-[#3e3e42] border-t-indigo-400 spin" />
        <p className="text-xs text-[#4a4a4a] font-mono">Loading Duckietown…</p>
      </div>
    );
  }

  return (
    <>
      {screen === "auth" && <AuthScreen onSignIn={handleSignIn} />}
      {screen === "setup" && <SetupScreen onSetup={handleSetup} />}
      {screen === "main" && vaultPath && (
        <MainScreen
          files={files}
          vaultPath={vaultPath}
          isWatching={isWatching}
          syncing={syncing}
          user={user}
          onDelete={handleDeleteFile}
          onRename={handleRenameFile}
          onOpen={handleOpenFile}
          onGetPreview={handleGetPreview}
          onOpenVault={() => wails.openVaultFolder()}
          onRefresh={loadFiles}
          onSignOut={handleSignOut}
        />
      )}
      <Toaster theme="dark" richColors position="bottom-right" />
    </>
  );
}
