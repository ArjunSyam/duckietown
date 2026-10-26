package main

import (
	"context"
	"fmt"
	"os"

	"github.com/joho/godotenv"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"duckietown/internal/agent"
	"duckietown/internal/authsvc"
	"duckietown/internal/config"
	"duckietown/internal/sidecar"
	"duckietown/internal/supabase"
	"duckietown/internal/vault"
)

// App is the Wails-bound composition root. It holds one instance of each
// internal service/client and exposes the methods the frontend calls,
// delegating every one of them straight down to a package.
type App struct {
	ctx context.Context

	supa     *supabase.Client
	sidecar  *sidecar.Client
	authSvc  *authsvc.Service
	vaultSvc *vault.Service
	agentSvc *agent.Service
}

func NewApp() *App {
	// .env.local (gitignored, real secrets) takes priority over .env (shared defaults)
	godotenv.Load(".env.local", ".env")

	supa := supabase.NewClient(os.Getenv("SUPABASE_URL"), os.Getenv("SUPABASE_KEY"))
	sc := sidecar.NewClient()
	vaultSvc := vault.NewService(supa, sc)
	authSvc := authsvc.NewService(supa)
	agentSvc := agent.NewService(vaultSvc)

	a := &App{
		supa:     supa,
		sidecar:  sc,
		authSvc:  authSvc,
		vaultSvc: vaultSvc,
		agentSvc: agentSvc,
	}

	// A token refresh triggered by a 401 updates authSvc's tokens; propagate
	// the new access token back into the shared supabase.Client.
	supa.OnUnauthorized = authSvc.RefreshAndSync

	// Any successful login/restore/refresh propagates the identity to
	// every service that needs it.
	authSvc.OnAuthChange = func(userID, accessToken string) {
		supa.SetUser(userID, accessToken)
		sc.SetUserID(userID)
		vaultSvc.SetUser(userID)
		agentSvc.SetUser(userID)
	}
	authSvc.OnSignOut = func() {
		supa.SetUser("", "")
		sc.SetUserID("")
		vaultSvc.Reset()
		agentSvc.SetUser("")
	}

	return a
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.authSvc.SetContext(ctx)
	a.vaultSvc.SetContext(ctx)
	a.agentSvc.SetContext(ctx)

	if err := a.authSvc.Startup(); err != nil {
		return // session existed but couldn't be restored — authSvc already emitted auth-expired
	}

	if a.vaultSvc.UserID == "" {
		return // no persisted session
	}

	cfg := config.LoadConfig(a.vaultSvc.UserID)
	if cfg.VaultPath == "" {
		return // signed in, but no vault selected yet
	}
	a.vaultSvc.Path = cfg.VaultPath

	if err := sidecar.Start(); err != nil {
		fmt.Printf("⚠️ Sidecar start failed: %v\n", err)
	}

	// Start the serialized ingest worker — one file at a time to respect Jina rate limits
	a.vaultSvc.StartIngestWorker()
	a.vaultSvc.StartWatcher()
	go a.vaultSvc.FullSync()
	wailsruntime.EventsEmit(a.ctx, "watcher-ready", true)
}

func (a *App) shutdown(ctx context.Context) {
	sidecar.Stop()
}

// ── Auth ───────────────────────────────────────────────────────────────

func (a *App) SignInWithGoogle() error           { return a.authSvc.SignInWithGoogle() }
func (a *App) SignOut()                          { a.authSvc.SignOut() }
func (a *App) GetCurrentUser() map[string]string { return a.authSvc.GetCurrentUser() }

// ── Vault ──────────────────────────────────────────────────────────────

func (a *App) GetVaultPath() string           { return a.vaultSvc.GetVaultPath() }
func (a *App) SetVaultPath(path string) error { return a.vaultSvc.SetVaultPath(path) }
func (a *App) SelectFolder() (string, error)  { return a.vaultSvc.SelectFolder() }
func (a *App) OpenVaultFolder() error         { return a.vaultSvc.OpenVaultFolder() }

// ── Files ──────────────────────────────────────────────────────────────

func (a *App) ListFiles() ([]supabase.FileRecord, error) { return a.vaultSvc.ListFiles() }
func (a *App) DeleteFile(fileName string) error          { return a.vaultSvc.DeleteFile(fileName) }
func (a *App) RenameFile(oldName, newName string) error {
	return a.vaultSvc.RenameFile(oldName, newName)
}
func (a *App) OpenFile(fileName string) error { return a.vaultSvc.OpenFile(fileName) }
func (a *App) GetFilePreview(fileName string) (string, error) {
	return a.vaultSvc.GetFilePreview(fileName)
}

// ── Folders ────────────────────────────────────────────────────────────

func (a *App) ListFolders() ([]vault.FolderRecord, error) { return a.vaultSvc.ListFolders() }
func (a *App) CreateFolder(relativePath string) error     { return a.vaultSvc.CreateFolder(relativePath) }
func (a *App) DeleteFolder(relativePath string) error     { return a.vaultSvc.DeleteFolder(relativePath) }
func (a *App) MoveFileToFolder(fileName, targetFolderPath string) error {
	return a.vaultSvc.MoveFileToFolder(fileName, targetFolderPath)
}

// ── AI: search, chat, organize ─────────────────────────────────────────

func (a *App) SemanticSearch(query string, topK int) ([]agent.SearchResult, error) {
	return a.agentSvc.SemanticSearch(query, topK)
}
func (a *App) GetChatModel() (string, error) {
	return a.agentSvc.GetChatModel()
}
func (a *App) ParseOrganiseIntent(message string) (agent.OrganiseIntent, error) {
	return a.agentSvc.ParseOrganiseIntent(message)
}
func (a *App) ChatWithAgent(message string, history []agent.ChatMessage, fileName string) {
	a.agentSvc.ChatWithAgent(message, history, fileName)
}
func (a *App) OrganiseFolder(currentFolderPath, query, newFolderName, typeFilter string) (agent.OrganiseFolderResult, error) {
	return a.agentSvc.OrganiseFolder(currentFolderPath, query, newFolderName, typeFilter)
}
