package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) GetVaultPath() string {
	if a.vaultPath != "" {
		return a.vaultPath
	}
	// Try loading from saved config for this user
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
	a.startWatcher()

	// Upload any existing files in the folder
	go func() {
		entries, err := os.ReadDir(path)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			fullPath := filepath.Join(path, entry.Name())
			a.supaUploadFile(fullPath, entry.Name())
		}
		wailsruntime.EventsEmit(a.ctx, "file-uploaded", "initial-scan")
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
