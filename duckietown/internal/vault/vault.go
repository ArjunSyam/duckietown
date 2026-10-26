// Package vault owns the local vault directory: file-system watching,
// folder management, file CRUD, and keeping Supabase + the sidecar's
// embeddings in sync with what's actually on disk.
package vault

import (
	"context"
	"fmt"
	"os"
	"sync"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"duckietown/internal/config"
	"duckietown/internal/sidecar"
	"duckietown/internal/supabase"
)

// Service holds vault state for the signed-in user. It is constructed once
// by the composition root and shared with the agent package (organize
// flow needs to search/move files in the vault too).
type Service struct {
	ctx    context.Context
	Path   string
	UserID string

	Supa    *supabase.Client
	Sidecar *sidecar.Client

	mu          sync.Mutex
	isWatching  bool
	watcherStop chan struct{}
}

func NewService(supa *supabase.Client, sc *sidecar.Client) *Service {
	return &Service{Supa: supa, Sidecar: sc}
}

func (s *Service) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// SetUser updates the signed-in identity. Called by the composition root
// whenever auth state changes.
func (s *Service) SetUser(userID string) {
	s.UserID = userID
}

// Reset clears vault state on sign-out: stop watching, forget the path.
func (s *Service) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Path = ""
	s.isWatching = false
	if s.watcherStop != nil {
		close(s.watcherStop)
		s.watcherStop = nil
	}
}

func (s *Service) GetVaultPath() string {
	if s.Path != "" {
		return s.Path
	}
	if s.UserID != "" {
		cfg := config.LoadConfig(s.UserID)
		if cfg.VaultPath != "" {
			s.Path = cfg.VaultPath
			return s.Path
		}
	}
	return ""
}

func (s *Service) SetVaultPath(path string) error {
	if err := os.MkdirAll(path, 0755); err != nil {
		return err
	}
	s.Path = path
	config.SaveConfig(s.UserID, config.Config{VaultPath: path})

	// Start sidecar + ingest worker before watcher so ingest is ready
	if err := sidecar.Start(); err != nil {
		fmt.Printf("⚠️ Sidecar start failed: %v\n", err)
	}
	s.StartIngestWorker()
	s.StartWatcher()

	// FullSync handles both upload to Supabase AND queuing ingest into
	// ChromaDB for all existing files in the vault, including subdirectories.
	go func() {
		s.FullSync()
		wailsruntime.EventsEmit(s.ctx, "watcher-ready", true)
	}()

	return nil
}

func (s *Service) SelectFolder() (string, error) {
	path, err := wailsruntime.OpenDirectoryDialog(s.ctx, wailsruntime.OpenDialogOptions{
		Title: "Choose your Duckietown vault folder",
	})
	if err != nil {
		return "", err
	}
	return path, nil
}

func (s *Service) OpenVaultFolder() error {
	if s.Path == "" {
		return fmt.Errorf("no vault path set")
	}
	return config.OpenPath(s.Path)
}
