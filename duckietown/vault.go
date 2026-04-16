package main

import (
	"fmt"
	"os"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) GetVaultPath() string {
	if a.vaultPath != "" {
		return a.vaultPath
	}
	if a.userID != "" {
		cfg := loadConfig(a.userID)
		if cfg.VaultPath != "" {
			a.vaultPath = cfg.VaultPath
			return a.vaultPath
		}
	}
	return ""
}

func (a *App) SetVaultPath(path string) error {
	if err := os.MkdirAll(path, 0755); err != nil {
		return err
	}
	a.vaultPath = path
	saveConfig(a.userID, Config{VaultPath: path})

	// Start sidecar + ingest worker before watcher so ingest is ready
	if err := a.startSidecar(); err != nil {
		fmt.Printf("⚠️ Sidecar start failed: %v\n", err)
	}
	a.startIngestWorker()
	a.startWatcher()

	// fullSync handles both upload to Supabase AND queuing ingest into ChromaDB
	// for all existing files in the vault, including subdirectories
	go func() {
		a.fullSync()
		wailsruntime.EventsEmit(a.ctx, "watcher-ready", true)
	}()

	return nil
}

func (a *App) SelectFolder() (string, error) {
	path, err := wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "Choose your Duckietown vault folder",
	})
	if err != nil {
		return "", err
	}
	return path, nil
}

func (a *App) OpenVaultFolder() error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path set")
	}
	return openPath(a.vaultPath)
}
