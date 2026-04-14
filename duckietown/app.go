package main

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/joho/godotenv"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx         context.Context
	vaultPath   string
	isWatching  bool
	watcherStop chan struct{}
	mu          sync.Mutex

	supaURL string
	supaKey string

	userID       string
	accessToken  string
	refreshToken string
	email        string
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
	session := loadSession()

	if session.RefreshToken != "" {
		a.refreshToken = session.RefreshToken
		a.userID = session.UserID
		a.email = session.Email

		err := a.refreshSession()
		if err != nil {
			clearSession()
			wailsruntime.EventsEmit(a.ctx, "auth-expired", nil)
			return
		}

		wailsruntime.EventsEmit(a.ctx, "auth-restored", map[string]string{
			"user_id": a.userID,
			"email":   a.email,
		})

		cfg := loadConfig(a.userID)
		if cfg.VaultPath != "" {
			a.vaultPath = cfg.VaultPath

			if err := a.startSidecar(); err != nil {
				fmt.Printf("⚠️ Sidecar start failed: %v\n", err)
			}

			// Start the serialized ingest worker — one file at a time to respect Jina rate limits
			a.startIngestWorker()

			a.startWatcher()
			go a.fullSync()
			wailsruntime.EventsEmit(a.ctx, "watcher-ready", true)
		}
	}
}

func (a *App) shutdown(ctx context.Context) {
	stopSidecar()
}
