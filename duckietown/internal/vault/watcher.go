package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// recentlyMoved tracks files that were moved/renamed within the vault.
// When we see a Create event for one of these, we suppress re-ingest
// because the embeddings were already updated via MoveFileEmbeddings.
var recentlyMoved = struct {
	sync.Mutex
	names map[string]time.Time
}{names: make(map[string]time.Time)}

func markMoved(name string) {
	recentlyMoved.Lock()
	recentlyMoved.names[name] = time.Now()
	recentlyMoved.Unlock()
}

func wasMoved(name string) bool {
	recentlyMoved.Lock()
	defer recentlyMoved.Unlock()
	t, ok := recentlyMoved.names[name]
	if !ok {
		return false
	}
	// Consider "recently moved" if within last 3 seconds
	if time.Since(t) > 3*time.Second {
		delete(recentlyMoved.names, name)
		return false
	}
	delete(recentlyMoved.names, name) // consume it — one-shot
	return true
}

func (s *Service) StartWatcher() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.isWatching && s.watcherStop != nil {
		close(s.watcherStop)
	}

	s.watcherStop = make(chan struct{})
	s.isWatching = true

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		fmt.Printf("Watcher init error: %v\n", err)
		return
	}

	filepath.WalkDir(s.Path, func(path string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		watcher.Add(path)
		return nil
	})
	fmt.Printf("👁 Watching: %s (recursive)\n", s.Path)

	go func(stop chan struct{}) {
		defer watcher.Close()
		for {
			select {
			case <-stop:
				return
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				s.handleFSEvent(event, watcher)
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				fmt.Printf("Watcher error: %v\n", err)
			}
		}
	}(s.watcherStop)
}

func shouldSkipFile(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	skipExts := []string{"~", ".tmp", ".crdownload", ".part", ".partial", ".download"}
	for _, ext := range skipExts {
		if strings.HasSuffix(name, ext) {
			return true
		}
	}
	if strings.HasPrefix(name, "Unconfirmed ") {
		return true
	}
	return false
}

func (s *Service) handleFSEvent(event fsnotify.Event, watcher *fsnotify.Watcher) {
	name := filepath.Base(event.Name)
	folderPath := s.folderPathForFile(event.Name)

	// Directory events
	info, statErr := os.Stat(event.Name)
	isDir := statErr == nil && info.IsDir()

	if isDir {
		switch {
		case event.Has(fsnotify.Create):
			watcher.Add(event.Name)
			rel, _ := filepath.Rel(s.Path, event.Name)
			wailsruntime.EventsEmit(s.ctx, "folder-created", filepath.ToSlash(rel))
		case event.Has(fsnotify.Remove), event.Has(fsnotify.Rename):
			rel, _ := filepath.Rel(s.Path, event.Name)
			wailsruntime.EventsEmit(s.ctx, "folder-deleted", filepath.ToSlash(rel))
		}
		return
	}

	if shouldSkipFile(name) {
		return
	}

	switch {
	case event.Has(fsnotify.Create), event.Has(fsnotify.Write):
		// If this file was just moved/renamed within the vault, suppress re-ingest.
		// The embeddings were already updated by MoveFileEmbeddings/RenameFile.
		if wasMoved(name) {
			// Still update Supabase storage path but DON'T re-ingest
			time.Sleep(200 * time.Millisecond)
			go func() {
				s.Supa.UploadFile(event.Name, name, folderPath)
				// Emit file-uploaded so the UI refreshes without the stuck syncing toast
				wailsruntime.EventsEmit(s.ctx, "file-uploaded", name)
			}()
			return
		}

		wailsruntime.EventsEmit(s.ctx, "file-changed", map[string]string{
			"event_type": "created",
			"file_name":  name,
			"path":       event.Name,
			"folder":     folderPath,
		})
		time.Sleep(200 * time.Millisecond)
		go func() {
			if err := s.Supa.UploadFile(event.Name, name, folderPath); err != nil {
				wailsruntime.EventsEmit(s.ctx, "upload-error", map[string]string{
					"file": name, "error": err.Error(),
				})
				// Dismiss syncing toast even on error
				wailsruntime.EventsEmit(s.ctx, "file-uploaded", name)
			} else {
				wailsruntime.EventsEmit(s.ctx, "file-uploaded", name)
				// Only ingest genuinely new files
				queueIngest(event.Name, name)
			}
		}()

	case event.Has(fsnotify.Rename):
		// Rename fires on OLD path. Give OS time to settle.
		time.Sleep(150 * time.Millisecond)

		newPath, newFolder, err := s.FindFileInVault(name)
		if err == nil && newPath != "" {
			// File moved within vault — update metadata, no re-ingest
			markMoved(name) // suppress the upcoming Create event from triggering ingest
			newSP := s.Supa.StoragePath(name, newFolder)
			go func() {
				s.Supa.DeleteStorageFile(name, folderPath)
				s.Supa.UploadFile(newPath, name, newFolder)
				s.Supa.UpdateFileFolderPath(name, newFolder, newSP)
				// Update ChromaDB metadata in-place — zero re-embedding
				s.Sidecar.MoveFileEmbeddings(name, name)
				wailsruntime.EventsEmit(s.ctx, "file-moved", map[string]string{
					"file_name":   name,
					"from_folder": folderPath,
					"to_folder":   newFolder,
				})
				// Dismiss any syncing toast
				wailsruntime.EventsEmit(s.ctx, "file-uploaded", name)
			}()
		} else {
			// File truly deleted from vault
			go func() {
				s.Supa.DeleteStorageFile(name, folderPath)
				s.Supa.DeleteFileRecord(name)
				s.Sidecar.DeleteFileEmbeddings(name) // ← always clean up embeddings on delete
			}()
			wailsruntime.EventsEmit(s.ctx, "file-changed", map[string]string{
				"event_type": "deleted",
				"file_name":  name,
			})
			wailsruntime.EventsEmit(s.ctx, "file-uploaded", name) // dismiss toast
		}

	case event.Has(fsnotify.Remove):
		go func() {
			s.Supa.DeleteStorageFile(name, folderPath)
			s.Supa.DeleteFileRecord(name)
			s.Sidecar.DeleteFileEmbeddings(name) // ← clean up embeddings
		}()
		wailsruntime.EventsEmit(s.ctx, "file-changed", map[string]string{
			"event_type": "deleted",
			"file_name":  name,
		})
		// Dismiss syncing toast immediately on delete
		wailsruntime.EventsEmit(s.ctx, "file-uploaded", name)
	}
}
