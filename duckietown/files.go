package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Types

type FileRecord struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	MimeType    string `json:"mime_type"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	StoragePath string `json:"storage_path"`
}

// File commands

func (a *App) ListFiles() ([]FileRecord, error) {
	return a.supaListFiles()
}

func (a *App) DeleteFile(fileName string) error {
	// Delete local copy
	localPath := filepath.Join(a.vaultPath, fileName)
	os.Remove(localPath)
	// Delete from storage bucket
	if err := a.supaDeleteStorageFile(fileName); err != nil {
		return err
	}
	// Delete metadata row from files table
	return a.supaDeleteFileRecord(fileName)
}

func (a *App) RenameFile(oldName, newName string) error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path")
	}
	oldPath := filepath.Join(a.vaultPath, oldName)
	newPath := filepath.Join(a.vaultPath, newName)

	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	if err := a.supaDeleteFileRecord(oldName); err != nil {
		return err
	}
	if err := a.supaDeleteStorageFile(oldName); err != nil {
		return err
	}
	go func() {
		a.supaUploadFile(newPath, newName)
	}()
	return nil
}

func (a *App) OpenFile(fileName string) error {
	// Open local file directly if it exists
	localPath := filepath.Join(a.vaultPath, fileName)
	if _, err := os.Stat(localPath); err == nil {
		return openPath(localPath)
	}

	// Otherwise download from Supabase to temp and open
	url, err := a.supaGetFileURL(fileName)
	if err != nil {
		return err
	}

	tmpPath := filepath.Join(os.TempDir(), fileName)
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("download error: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read error: %w", err)
	}
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write error: %w", err)
	}
	return openPath(tmpPath)
}

func (a *App) GetFilePreview(fileName string) (string, error) {
	return a.supaGetFileURL(fileName)
}

func (a *App) fullSync() {
	if a.vaultPath == "" || a.userID == "" {
		return
	}

	localFiles := make(map[string]string)
	entries, err := os.ReadDir(a.vaultPath)
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") ||
				strings.HasSuffix(entry.Name(), "~") ||
				strings.HasSuffix(entry.Name(), ".tmp") {
				continue
			}
			localFiles[entry.Name()] = filepath.Join(a.vaultPath, entry.Name())
		}
	}

	dbFiles, err := a.supaListFiles()
	if err != nil {
		return
	}
	dbSet := make(map[string]bool)
	for _, f := range dbFiles {
		dbSet[f.Name] = true
	}

	storageFiles, err := a.supaListStorageFiles()
	if err != nil {
		return
	}
	storageSet := make(map[string]bool)
	for _, name := range storageFiles {
		storageSet[name] = true
	}

	// Upload local files not in bucket or db
	for name, path := range localFiles {
		if !storageSet[name] || !dbSet[name] {
			a.supaUploadFile(path, name)
		}
	}

	// Delete db records for files no longer local or in bucket
	for _, f := range dbFiles {
		_, existsLocally := localFiles[f.Name]
		if !existsLocally && !storageSet[f.Name] {
			a.supaDeleteFileRecord(f.Name)
		}
	}

	// Delete storage files no longer local
	for _, name := range storageFiles {
		if _, existsLocally := localFiles[name]; !existsLocally {
			a.supaDeleteStorageFile(name)
			a.supaDeleteFileRecord(name)
		}
	}

	wailsruntime.EventsEmit(a.ctx, "file-uploaded", "sync-complete")
}
