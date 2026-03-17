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

	// Stop existing watcher if running
	if a.isWatching && a.watcherStop != nil {
		close(a.watcherStop)
	}

	a.watcherStop = make(chan struct{})
	a.isWatching = true

	go func(stop chan struct{}, vaultPath string) {
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			return
		}
		defer watcher.Close()
		watcher.Add(vaultPath)

		fmt.Printf("👁 Watching: %s\n", vaultPath)

		for {
			select {
			case <-stop:
				return
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				a.handleFSEvent(event)
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				fmt.Printf("Watcher error: %v\n", err)
			}
		}
	}(a.watcherStop, a.vaultPath)
}

func (a *App) handleFSEvent(event fsnotify.Event) {
	name := filepath.Base(event.Name)

	// Skip hidden and temp files
	if strings.HasPrefix(name, ".") ||
		strings.HasSuffix(name, "~") ||
		strings.HasSuffix(name, ".tmp") {
		return
	}

	// Skip directories
	info, err := os.Stat(event.Name)
	if err == nil && info.IsDir() {
		return
	}

	switch {
	case event.Has(fsnotify.Create), event.Has(fsnotify.Write):
		wailsruntime.EventsEmit(a.ctx, "file-changed", map[string]string{
			"event_type": "created",
			"file_name":  name,
			"path":       event.Name,
		})
		// Small delay to ensure file is fully written before reading
		time.Sleep(200 * time.Millisecond)
		go func() {
			if err := a.supaUploadFile(event.Name, name); err != nil {
				wailsruntime.EventsEmit(a.ctx, "upload-error", map[string]string{
					"file": name, "error": err.Error(),
				})
			} else {
				wailsruntime.EventsEmit(a.ctx, "file-uploaded", name)
			}
		}()

	case event.Has(fsnotify.Remove):
		wailsruntime.EventsEmit(a.ctx, "file-changed", map[string]string{
			"event_type": "deleted",
			"file_name":  name,
		})
	}
}
