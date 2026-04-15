package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

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

	// Watch vault root and all existing subdirectories recursively
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

// watchDir adds a single directory to the active watcher (called on folder create).
func (a *App) watchDir(absPath string) {
	// The watcher is stored in the goroutine — we trigger it by creating the dir,
	// which fires a Create event that we catch below and add to watcher.
	// So no explicit handle needed here; the Create event handler does it.
	_ = absPath
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

	// If it's a directory event
	info, statErr := os.Stat(event.Name)
	isDir := statErr == nil && info.IsDir()

	if isDir {
		switch {
		case event.Has(fsnotify.Create):
			// New directory — add to watcher and notify frontend
			watcher.Add(event.Name)
			rel, _ := filepath.Rel(a.vaultPath, event.Name)
			rel = filepath.ToSlash(rel)
			wailsruntime.EventsEmit(a.ctx, "folder-created", rel)
		case event.Has(fsnotify.Remove):
			rel, _ := filepath.Rel(a.vaultPath, event.Name)
			rel = filepath.ToSlash(rel)
			wailsruntime.EventsEmit(a.ctx, "folder-deleted", rel)
		case event.Has(fsnotify.Rename):
			// Rename of dir — treated as delete; the new name fires Create
			rel, _ := filepath.Rel(a.vaultPath, event.Name)
			rel = filepath.ToSlash(rel)
			wailsruntime.EventsEmit(a.ctx, "folder-deleted", rel)
		}
		return
	}

	if shouldSkipFile(name) {
		return
	}

	switch {
	case event.Has(fsnotify.Create), event.Has(fsnotify.Write):
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
			} else {
				wailsruntime.EventsEmit(a.ctx, "file-uploaded", name)
				queueIngest(event.Name, name)
			}
		}()

	case event.Has(fsnotify.Rename):
		// fsnotify Rename fires on the OLD path when a file is moved/renamed.
		// The new path fires a Create event. We handle the delete side here.
		// If the file moved within the vault, the Create will re-upload under new path.
		wailsruntime.EventsEmit(a.ctx, "file-changed", map[string]string{
			"event_type": "deleted",
			"file_name":  name,
		})
		// Give a short window for the Create event to arrive (same-vault move)
		time.Sleep(100 * time.Millisecond)
		// Check if file still exists somewhere in vault (move vs true delete)
		newPath, newFolder, err := a.findFileInVault(name)
		if err == nil && newPath != "" {
			// File was moved within vault — update Supabase folder_path only
			newSP := a.storagePath(name, newFolder)
			a.supaDeleteStorageFile(name, folderPath)
			a.supaUploadFile(newPath, name, newFolder)
			a.supaUpdateFileFolderPath(name, newFolder, newSP)
			// Update ChromaDB metadata — no re-embed
			go a.MoveFileEmbeddings(name, name)
			wailsruntime.EventsEmit(a.ctx, "file-moved", map[string]string{
				"file_name":   name,
				"from_folder": folderPath,
				"to_folder":   newFolder,
			})
		} else {
			// File truly deleted
			a.supaDeleteStorageFile(name, folderPath)
			a.supaDeleteFileRecord(name)
			go a.DeleteFileEmbeddings(name)
		}

	case event.Has(fsnotify.Remove):
		wailsruntime.EventsEmit(a.ctx, "file-changed", map[string]string{
			"event_type": "deleted",
			"file_name":  name,
		})
		a.supaDeleteStorageFile(name, folderPath)
		a.supaDeleteFileRecord(name)
		go a.DeleteFileEmbeddings(name)
	}
}
