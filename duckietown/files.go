package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type FileRecord struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	MimeType    string `json:"mime_type"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	StoragePath string `json:"storage_path"`
}

var ingestQueue = make(chan ingestJob, 64)

type ingestJob struct {
	filePath string
	fileName string
}

func (a *App) startIngestWorker() {
	go func() {
		for job := range ingestQueue {
			if err := a.IngestFile(job.filePath, job.fileName); err != nil {
				fmt.Printf("⚠️ Ingest failed for %s: %v\n", job.fileName, err)
			} else {
				fmt.Printf("🧠 Ingested: %s\n", job.fileName)
			}
		}
	}()
}

func queueIngest(filePath, fileName string) {
	select {
	case ingestQueue <- ingestJob{filePath, fileName}:
	default:
		fmt.Printf("⚠️ Ingest queue full, skipping %s\n", fileName)
	}
}

func (a *App) ListFiles() ([]FileRecord, error) {
	return a.supaListFiles()
}

func (a *App) DeleteFile(fileName string) error {
	localPath := filepath.Join(a.vaultPath, fileName)
	os.Remove(localPath)
	if err := a.supaDeleteStorageFile(fileName); err != nil {
		return err
	}
	if err := a.supaDeleteFileRecord(fileName); err != nil {
		return err
	}
	go a.DeleteFileEmbeddings(fileName)
	return nil
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
		queueIngest(newPath, newName)
		a.DeleteFileEmbeddings(oldName)
	}()
	return nil
}

func (a *App) OpenFile(fileName string) error {
	localPath := filepath.Join(a.vaultPath, fileName)
	if _, err := os.Stat(localPath); err == nil {
		return openPath(localPath)
	}

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
			name := entry.Name()
			if entry.IsDir() || shouldSkipFile(name) {
				continue
			}
			localFiles[name] = filepath.Join(a.vaultPath, name)
		}
	}

	dbFiles, err := a.supaListFiles()
	if err != nil {
		fmt.Printf("dbfile err: %v\n", err)
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

	indexed, err := a.GetIndexedFiles()
	if err != nil {
		fmt.Printf("⚠️ Could not get indexed files, will re-ingest all: %v\n", err)
		indexed = make(map[string]bool)
	}
	fmt.Printf("📚 Already indexed: %d files\n", len(indexed))

	for name, path := range localFiles {
		if !storageSet[name] || !dbSet[name] {
			a.supaUploadFile(path, name)
		}
		if !indexed[name] {
			fmt.Printf("🧠 Queuing ingest: %s\n", name)
			queueIngest(path, name)
		}
	}

	for _, f := range dbFiles {
		_, existsLocally := localFiles[f.Name]
		if !existsLocally && !storageSet[f.Name] {
			a.supaDeleteFileRecord(f.Name)
		}
	}

	for _, name := range storageFiles {
		if _, existsLocally := localFiles[name]; !existsLocally {
			a.supaDeleteStorageFile(name)
			a.supaDeleteFileRecord(name)
			go a.DeleteFileEmbeddings(name)
		}
	}

	wailsruntime.EventsEmit(a.ctx, "file-uploaded", "sync-complete")
}
