package vault

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"duckietown/internal/config"
	"duckietown/internal/supabase"
)

// ── Ingest queue ─────────────────────────────────────────────────────────

var ingestQueue = make(chan ingestJob, 256)
var ingestPending atomic.Int32 // count of jobs waiting or in progress

type ingestJob struct {
	filePath string
	fileName string
}

func (s *Service) StartIngestWorker() {
	go func() {
		for job := range ingestQueue {
			// Emit "ingesting" event so frontend can show status
			wailsruntime.EventsEmit(s.ctx, "ingest-start", map[string]string{
				"file_name": job.fileName,
				"pending":   fmt.Sprintf("%d", ingestPending.Load()),
			})

			if err := s.Sidecar.IngestFile(job.filePath, job.fileName); err != nil {
				fmt.Printf("⚠️ Ingest failed for %s: %v\n", job.fileName, err)
				wailsruntime.EventsEmit(s.ctx, "ingest-error", map[string]string{
					"file_name": job.fileName,
					"error":     err.Error(),
				})
			} else {
				fmt.Printf("🧠 Ingested: %s\n", job.fileName)
			}

			remaining := ingestPending.Add(-1)

			// Emit progress after each file
			wailsruntime.EventsEmit(s.ctx, "ingest-progress", map[string]interface{}{
				"file_name": job.fileName,
				"remaining": remaining,
			})

			// When queue fully drained, emit done
			if remaining == 0 {
				wailsruntime.EventsEmit(s.ctx, "ingest-done", nil)
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

// ── File operations ─────────────────────────────────────────────────────

func (s *Service) ListFiles() ([]supabase.FileRecord, error) {
	return s.Supa.ListFiles()
}

func (s *Service) DeleteFile(fileName string) error {
	absPath, folderPath, err := s.FindFileInVault(fileName)
	if err != nil {
		absPath = filepath.Join(s.Path, fileName)
		folderPath = ""
	}
	os.Remove(absPath)
	if err := s.Supa.DeleteStorageFile(fileName, folderPath); err != nil {
		return err
	}
	if err := s.Supa.DeleteFileRecord(fileName); err != nil {
		return err
	}
	go s.Sidecar.DeleteFileEmbeddings(fileName)
	return nil
}

func (s *Service) RenameFile(oldName, newName string) error {
	if s.Path == "" {
		return fmt.Errorf("no vault path")
	}
	oldAbsPath, folderPath, err := s.FindFileInVault(oldName)
	if err != nil {
		return fmt.Errorf("file not found: %w", err)
	}
	newAbsPath := filepath.Join(filepath.Dir(oldAbsPath), newName)

	if err := os.Rename(oldAbsPath, newAbsPath); err != nil {
		return err
	}

	newSP := s.Supa.StoragePath(newName, folderPath)
	s.Supa.UploadFile(newAbsPath, newName, folderPath)
	s.Supa.DeleteStorageFile(oldName, folderPath)
	s.Supa.RenameFileRecord(oldName, newName, folderPath, newSP)

	go func() {
		if err := s.Sidecar.MoveFileEmbeddings(oldName, newName); err != nil {
			fmt.Printf("⚠️ Failed to update embeddings for rename %s → %s: %v\n", oldName, newName, err)
		}
	}()
	return nil
}

func (s *Service) OpenFile(fileName string) error {
	absPath, folderPath, err := s.FindFileInVault(fileName)
	if err == nil {
		return config.OpenPath(absPath)
	}

	url, err := s.Supa.GetFileURL(fileName, folderPath)
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
	return config.OpenPath(tmpPath)
}

func (s *Service) GetFilePreview(fileName string) (string, error) {
	_, folderPath, err := s.FindFileInVault(fileName)
	if err != nil {
		folderPath = ""
	}
	return s.Supa.GetFileURL(fileName, folderPath)
}

// ── Full sync ────────────────────────────────────────────────────────────

func (s *Service) FullSync() {
	if s.Path == "" || s.UserID == "" {
		return
	}

	// Build local file map: name → {absPath, folderPath}
	type localEntry struct{ abs, folder string }
	localFiles := make(map[string]localEntry)

	filepath.WalkDir(s.Path, func(path string, d os.DirEntry, err error) error {
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
		fp := s.folderPathForFile(path)
		localFiles[name] = localEntry{path, fp}
		return nil
	})

	dbFiles, err := s.Supa.ListFiles()
	if err != nil {
		fmt.Printf("dbfile err: %v\n", err)
		return
	}
	dbSet := make(map[string]string)
	for _, f := range dbFiles {
		dbSet[f.Name] = f.FolderPath
	}

	storageFiles, err := s.Supa.ListStorageFiles()
	if err != nil {
		return
	}
	storageSet := make(map[string]bool)
	for _, sp := range storageFiles {
		parts := strings.Split(sp, "/")
		storageSet[parts[len(parts)-1]] = true
	}

	indexed, err := s.Sidecar.GetIndexedFiles()
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
		wailsruntime.EventsEmit(s.ctx, "ingest-queued", map[string]interface{}{
			"total": toIngest,
		})
	}

	for name, entry := range localFiles {
		if !storageSet[name] || dbSet[name] == "" {
			s.Supa.UploadFile(entry.abs, name, entry.folder)
		}
		if !indexed[name] {
			fmt.Printf("🧠 Queuing ingest: %s\n", name)
			queueIngest(entry.abs, name)
		}
	}

	for _, f := range dbFiles {
		_, existsLocally := localFiles[f.Name]
		if !existsLocally && !storageSet[f.Name] {
			s.Supa.DeleteFileRecord(f.Name)
		}
	}

	for _, sp := range storageFiles {
		parts := strings.Split(sp, "/")
		name := parts[len(parts)-1]
		if _, existsLocally := localFiles[name]; !existsLocally {
			folder := strings.Join(parts[:len(parts)-1], "/")
			s.Supa.DeleteStorageFile(name, folder)
			s.Supa.DeleteFileRecord(name)
			go s.Sidecar.DeleteFileEmbeddings(name)
		}
	}

	wailsruntime.EventsEmit(s.ctx, "file-uploaded", "sync-complete")
}
