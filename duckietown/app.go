package main

import (
	"context"
	"os"
	"sync"

	"github.com/joho/godotenv"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx         context.Context
	vaultPath   string
	isWatching  bool
	watcherStop chan struct{}
	mu          sync.Mutex

	// Supabase
	supaURL string
	supaKey string

	// Auth
	userID      string
	accessToken string
	email       string
}

func NewApp() *App {
	godotenv.Load()
	return &App{
		supaURL: os.Getenv("SUPABASE_URL"),
		supaKey: os.Getenv("SUPABASE_KEY"),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// If we have a saved session, restore it and check vault
	session := loadSession()
	if session.AccessToken != "" && session.UserID != "" {
		a.accessToken = session.AccessToken
		a.userID = session.UserID
		a.email = session.Email

		// Emit auth restored so frontend can skip auth screen
		wailsruntime.EventsEmit(a.ctx, "auth-restored", map[string]string{
			"user_id": a.userID,
			"email":   a.email,
		})

		// Restore vault if set
		cfg := loadConfig(a.userID)
		if cfg.VaultPath != "" {
			a.vaultPath = cfg.VaultPath
			a.startWatcher()
			go a.fullSync()
			wailsruntime.EventsEmit(a.ctx, "watcher-ready", true)
		}
	}
}
