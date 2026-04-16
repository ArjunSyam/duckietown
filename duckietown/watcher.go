package main

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

func (a *App) startWatcher() {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.isWatching && a.watcherStop != nil {
		close(a.watcherStop)
	}

	a.watcherStop = make(chan struct{})
	a.isWatching = true

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		fmt.Printf("Watcher init error: %v\n", err)
		return
	}

	filepath.WalkDir(a.vaultPath, func(path string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		watcher.Add(path)
		return nil
	})
	fmt.Printf("👁 Watching: %s (recursive)\n", a.vaultPath)

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
				a.handleFSEvent(event, watcher)
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				fmt.Printf("Watcher error: %v\n", err)
			}
		}
	}(a.watcherStop)
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

func (a *App) handleFSEvent(event fsnotify.Event, watcher *fsnotify.Watcher) {
	name := filepath.Base(event.Name)
	folderPath := a.folderPathForFile(event.Name)

	// Directory events
	info, statErr := os.Stat(event.Name)
	isDir := statErr == nil && info.IsDir()

	if isDir {
		switch {
		case event.Has(fsnotify.Create):
			watcher.Add(event.Name)
			rel, _ := filepath.Rel(a.vaultPath, event.Name)
			wailsruntime.EventsEmit(a.ctx, "folder-created", filepath.ToSlash(rel))
		case event.Has(fsnotify.Remove), event.Has(fsnotify.Rename):
			rel, _ := filepath.Rel(a.vaultPath, event.Name)
			wailsruntime.EventsEmit(a.ctx, "folder-deleted", filepath.ToSlash(rel))
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
				a.supaUploadFile(event.Name, name, folderPath)
				// Emit file-uploaded so the UI refreshes without the stuck syncing toast
				wailsruntime.EventsEmit(a.ctx, "file-uploaded", name)
			}()
			return
		}

		wailsruntime.EventsEmit(a.ctx, "file-changed", map[string]string{
			"event_type": "created",
			"file_name":  name,
			"path":       event.Name,
			"folder":     folderPath,
		})
		time.Sleep(200 * time.Millisecond)
		go func() {
			if err := a.supaUploadFile(event.Name, name, folderPath); err != nil {
				wailsruntime.EventsEmit(a.ctx, "upload-error", map[string]string{
					"file": name, "error": err.Error(),
				})
				// Dismiss syncing toast even on error
				wailsruntime.EventsEmit(a.ctx, "file-uploaded", name)
			} else {
				wailsruntime.EventsEmit(a.ctx, "file-uploaded", name)
				// Only ingest genuinely new files
				queueIngest(event.Name, name)
			}
		}()

	case event.Has(fsnotify.Rename):
		// Rename fires on OLD path. Give OS time to settle.
		time.Sleep(150 * time.Millisecond)

		newPath, newFolder, err := a.findFileInVault(name)
		if err == nil && newPath != "" {
			// File moved within vault — update metadata, no re-ingest
			markMoved(name) // suppress the upcoming Create event from triggering ingest
			newSP := a.storagePath(name, newFolder)
			go func() {
				a.supaDeleteStorageFile(name, folderPath)
				a.supaUploadFile(newPath, name, newFolder)
				a.supaUpdateFileFolderPath(name, newFolder, newSP)
				// Update ChromaDB metadata in-place — zero re-embedding
				a.MoveFileEmbeddings(name, name)
				wailsruntime.EventsEmit(a.ctx, "file-moved", map[string]string{
					"file_name":   name,
					"from_folder": folderPath,
					"to_folder":   newFolder,
				})
				// Dismiss any syncing toast
				wailsruntime.EventsEmit(a.ctx, "file-uploaded", name)
			}()
		} else {
			// File truly deleted from vault
			go func() {
				a.supaDeleteStorageFile(name, folderPath)
				a.supaDeleteFileRecord(name)
				a.DeleteFileEmbeddings(name) // ← always clean up embeddings on delete
			}()
			wailsruntime.EventsEmit(a.ctx, "file-changed", map[string]string{
				"event_type": "deleted",
				"file_name":  name,
			})
			wailsruntime.EventsEmit(a.ctx, "file-uploaded", name) // dismiss toast
		}

	case event.Has(fsnotify.Remove):
		go func() {
			a.supaDeleteStorageFile(name, folderPath)
			a.supaDeleteFileRecord(name)
			a.DeleteFileEmbeddings(name) // ← clean up embeddings
		}()
		wailsruntime.EventsEmit(a.ctx, "file-changed", map[string]string{
			"event_type": "deleted",
			"file_name":  name,
		})
		// Dismiss syncing toast immediately on delete
		wailsruntime.EventsEmit(a.ctx, "file-uploaded", name)
	}
}
