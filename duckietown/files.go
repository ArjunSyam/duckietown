package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type FileRecord struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	MimeType    string `json:"mime_type"`
	FolderPath  string `json:"folder_path"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	StoragePath string `json:"storage_path"`
}

// ── Ingest queue ───────────────────────────────────────────────────────────────

var ingestQueue = make(chan ingestJob, 256)
var ingestPending atomic.Int32 // count of jobs waiting or in progress

type ingestJob struct {
	filePath string
	fileName string
}

func (a *App) startIngestWorker() {
	go func() {
		for job := range ingestQueue {
			// Emit "ingesting" event so frontend can show status
			wailsruntime.EventsEmit(a.ctx, "ingest-start", map[string]string{
				"file_name": job.fileName,
				"pending":   fmt.Sprintf("%d", ingestPending.Load()),
			})

			if err := a.IngestFile(job.filePath, job.fileName); err != nil {
				fmt.Printf("⚠️ Ingest failed for %s: %v\n", job.fileName, err)
				wailsruntime.EventsEmit(a.ctx, "ingest-error", map[string]string{
					"file_name": job.fileName,
					"error":     err.Error(),
				})
			} else {
				fmt.Printf("🧠 Ingested: %s\n", job.fileName)
			}

			remaining := ingestPending.Add(-1)

			// Emit progress after each file
			wailsruntime.EventsEmit(a.ctx, "ingest-progress", map[string]interface{}{
				"file_name": job.fileName,
				"remaining": remaining,
			})

			// When queue fully drained, emit done
			if remaining == 0 {
				wailsruntime.EventsEmit(a.ctx, "ingest-done", nil)
			}
		}
	}()
}

func queueIngest(filePath, fileName string) {
	ingestPending.Add(1)
	select {
	case ingestQueue <- ingestJob{filePath, fileName}:
	default:
		// Queue full — decrement counter since job won't run
		ingestPending.Add(-1)
		fmt.Printf("⚠️ Ingest queue full, skipping %s\n", fileName)
	}
}

// ── File operations ────────────────────────────────────────────────────────────

func (a *App) ListFiles() ([]FileRecord, error) {
	return a.supaListFiles()
}

func (a *App) DeleteFile(fileName string) error {
	absPath, folderPath, err := a.findFileInVault(fileName)
	if err != nil {
		absPath = filepath.Join(a.vaultPath, fileName)
		folderPath = ""
	}
	os.Remove(absPath)
	if err := a.supaDeleteStorageFile(fileName, folderPath); err != nil {
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
	oldAbsPath, folderPath, err := a.findFileInVault(oldName)
	if err != nil {
		return fmt.Errorf("file not found: %w", err)
	}
	newAbsPath := filepath.Join(filepath.Dir(oldAbsPath), newName)

	if err := os.Rename(oldAbsPath, newAbsPath); err != nil {
		return err
	}

	newSP := a.storagePath(newName, folderPath)
	a.supaUploadFile(newAbsPath, newName, folderPath)
	a.supaDeleteStorageFile(oldName, folderPath)
	a.supaRenameFileRecord(oldName, newName, folderPath, newSP)

	go func() {
		if err := a.MoveFileEmbeddings(oldName, newName); err != nil {
			fmt.Printf("⚠️ Failed to update embeddings for rename %s → %s: %v\n", oldName, newName, err)
		}
	}()
	return nil
}

func (a *App) OpenFile(fileName string) error {
	absPath, folderPath, err := a.findFileInVault(fileName)
	if err == nil {
		return openPath(absPath)
	}

	url, err := a.supaGetFileURL(fileName, folderPath)
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
	_, folderPath, err := a.findFileInVault(fileName)
	if err != nil {
		folderPath = ""
	}
	return a.supaGetFileURL(fileName, folderPath)
}

// ── Full sync ──────────────────────────────────────────────────────────────────

func (a *App) fullSync() {
	if a.vaultPath == "" || a.userID == "" {
		return
	}

	// Build local file map: name → {absPath, folderPath}
	type localEntry struct{ abs, folder string }
	localFiles := make(map[string]localEntry)

	filepath.WalkDir(a.vaultPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if shouldSkipFile(name) {
			return nil
		}
		fp := a.folderPathForFile(path)
		localFiles[name] = localEntry{path, fp}
		return nil
	})

	dbFiles, err := a.supaListFiles()
	if err != nil {
		fmt.Printf("dbfile err: %v\n", err)
		return
	}
	dbSet := make(map[string]string)
	for _, f := range dbFiles {
		dbSet[f.Name] = f.FolderPath
	}

	storageFiles, err := a.supaListStorageFiles()
	if err != nil {
		return
	}
	storageSet := make(map[string]bool)
	for _, sp := range storageFiles {
		parts := strings.Split(sp, "/")
		storageSet[parts[len(parts)-1]] = true
	}

	indexed, err := a.GetIndexedFiles()
	if err != nil {
		fmt.Printf("⚠️ Could not get indexed files, will re-ingest all: %v\n", err)
		indexed = make(map[string]bool)
	}
	fmt.Printf("📚 Already indexed: %d files\n", len(indexed))

	// Count how many need ingesting so frontend can show total
	toIngest := 0
	for name := range localFiles {
		if !indexed[name] {
			toIngest++
		}
	}
	if toIngest > 0 {
		wailsruntime.EventsEmit(a.ctx, "ingest-queued", map[string]interface{}{
			"total": toIngest,
		})
	}

	for name, entry := range localFiles {
		if !storageSet[name] || dbSet[name] == "" {
			a.supaUploadFile(entry.abs, name, entry.folder)
		}
		if !indexed[name] {
			fmt.Printf("🧠 Queuing ingest: %s\n", name)
			queueIngest(entry.abs, name)
		}
	}

	for _, f := range dbFiles {
		_, existsLocally := localFiles[f.Name]
		if !existsLocally && !storageSet[f.Name] {
			a.supaDeleteFileRecord(f.Name)
		}
	}

	for _, sp := range storageFiles {
		parts := strings.Split(sp, "/")
		name := parts[len(parts)-1]
		if _, existsLocally := localFiles[name]; !existsLocally {
			folder := strings.Join(parts[:len(parts)-1], "/")
			a.supaDeleteStorageFile(name, folder)
			a.supaDeleteFileRecord(name)
			go a.DeleteFileEmbeddings(name)
		}
	}

	wailsruntime.EventsEmit(a.ctx, "file-uploaded", "sync-complete")
}
