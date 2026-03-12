package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/joho/godotenv"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ── Types ──────────────────────────────────────────────

type FileRecord struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	MimeType    string `json:"mime_type"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	StoragePath string `json:"storage_path"`
	IsDir       bool   `json:"is_dir"`
}

type Config struct {
	VaultPath string `json:"vault_path"`
}

// ── App struct ─────────────────────────────────────────

type App struct {
	ctx         context.Context
	vaultPath   string
	isWatching  bool
	watcherStop chan struct{}
	mu          sync.Mutex
	supaURL     string
	supaKey     string
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
	cfg := a.loadConfig()
	if cfg.VaultPath != "" {
		a.vaultPath = cfg.VaultPath
		a.startWatcher()
		wailsruntime.EventsEmit(a.ctx, "watcher-ready", true)
	}
}

// ── Config persistence ─────────────────────────────────

func configPath() string {
	cfgDir, _ := os.UserConfigDir()
	dir := filepath.Join(cfgDir, "duckietown")
	os.MkdirAll(dir, 0755)
	return filepath.Join(dir, "config.json")
}

func (a *App) loadConfig() Config {
	data, err := os.ReadFile(configPath())
	if err != nil {
		return Config{}
	}
	var cfg Config
	json.Unmarshal(data, &cfg)
	return cfg
}

func (a *App) saveConfig(cfg Config) {
	data, _ := json.Marshal(cfg)
	os.WriteFile(configPath(), data, 0644)
}

// ── Vault commands ─────────────────────────────────────

func (a *App) GetVaultPath() string {
	return a.vaultPath
}

func (a *App) SetVaultPath(path string) error {
	if err := os.MkdirAll(path, 0755); err != nil {
		return err
	}
	a.vaultPath = path
	a.saveConfig(Config{VaultPath: path})
	a.startWatcher()

	//Uploading any existing files that aren't in Supabase yet
	go func() {
		entries, err := os.ReadDir(path)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			fullPath := filepath.Join(path, entry.Name())
			a.supaUploadFile(fullPath, entry.Name())
		}
		wailsruntime.EventsEmit(a.ctx, "file-uploaded", "initial-scan")
	}()

	return nil
}

func (a *App) SelectFolder() (string, error) {
	path, err := wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "Choose your Duckietown vault folder",
	})
	if err != nil {
		return "", err
	}
	return path, nil
}

func (a *App) OpenVaultFolder() error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path set")
	}
	return openPath(a.vaultPath)
}

func openPath(path string) error {
	switch goruntime.GOOS {
	case "windows":
		return exec.Command("cmd", "/c", "start", "", path).Start()
	case "darwin":
		return exec.Command("open", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}

// ── File operations ────────────────────────────────────

func (a *App) ListFiles() ([]FileRecord, error) {
	return a.supaListFiles()
}

func (a *App) DeleteFile(fileName string) error {
	localPath := filepath.Join(a.vaultPath, fileName)
	os.Remove(localPath)
	return a.supaDeleteFile(fileName)
}

func (a *App) RenameFile(oldName, newName string) error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path")
	}
	oldPath := filepath.Join(a.vaultPath, oldName)
	newPath := filepath.Join(a.vaultPath, newName)
	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	go func() {
		a.supaUploadFile(newPath, newName)
		a.supaDeleteFile(oldName)
	}()
	return nil
}

func (a *App) OpenFile(fileName string) error {
	localPath := filepath.Join(a.vaultPath, fileName)
	if _, err := os.Stat(localPath); err == nil {
		return openPath(localPath)
	}

	url, err := a.supaGetFileURL(fileName)
	if err != nil {
		return err
	}

	tmpPath := filepath.Join(os.TempDir(), fileName)
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("download error %w", err)
	}

	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read error %w", err)
	}

	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write error %w", err)
	}

	return openPath(tmpPath)
}

func (a *App) GetFilePreview(fileName string) (string, error) {
	return a.supaGetFileURL(fileName)
}

// ── File watcher ───────────────────────────────────────

func (a *App) startWatcher() {
	a.mu.Lock()
	defer a.mu.Unlock()

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
	if strings.HasPrefix(name, ".") || strings.HasSuffix(name, "~") || strings.HasSuffix(name, ".tmp") {
		return
	}
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

// ── Supabase ───────────────────────────────────────────

const bucket = "duckietown"

func (a *App) supaHeaders(req *http.Request) {
	req.Header.Set("apikey", a.supaKey)
	req.Header.Set("Authorization", "Bearer "+a.supaKey)
}

func getMimeType(fileName string) string {
	mime.AddExtensionType(".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	mime.AddExtensionType(".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	mime.AddExtensionType(".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")
	mime.AddExtensionType(".doc", "application/msword")
	mime.AddExtensionType(".xls", "application/vnd.ms-excel")
	mime.AddExtensionType(".ppt", "application/vnd.ms-powerpoint")
	mime.AddExtensionType(".md", "text/markdown")
	mime.AddExtensionType(".csv", "text/csv")
	mimeType := mime.TypeByExtension(filepath.Ext(fileName))
	if mimeType == "" {
		return "application/octet-stream"
	}
	return mimeType
}

func (a *App) supaUploadFile(filePath, fileName string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("read error: %w", err)
	}
	mimeType := getMimeType(fileName)
	url := fmt.Sprintf("%s/storage/v1/object/%s/%s", a.supaURL, bucket, fileName)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(data))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", mimeType)
	req.Header.Set("x-upsert", "true")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload failed [%d]: %s", resp.StatusCode, string(body))
	}
	return nil
}

type supaObject struct {
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Metadata  *struct {
		Size     int64  `json:"size"`
		MimeType string `json:"mimetype"`
	} `json:"metadata"`
}

func (a *App) supaListFiles() ([]FileRecord, error) {
	url := fmt.Sprintf("%s/storage/v1/object/list/%s", a.supaURL, bucket)
	body := `{"prefix":"","limit":1000,"offset":0}`
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	var objects []supaObject
	if err := json.NewDecoder(resp.Body).Decode(&objects); err != nil {
		return nil, fmt.Errorf("parse error: %w", err)
	}

	var files []FileRecord
	for _, o := range objects {
		if o.Name == "" || o.Name == ".emptyFolderPlaceholder" {
			continue
		}
		var size int64
		mimeType := getMimeType(o.Name)
		if o.Metadata != nil {
			size = o.Metadata.Size
			if o.Metadata.MimeType != "" {
				mimeType = o.Metadata.MimeType
			}
		}
		files = append(files, FileRecord{
			Name:        o.Name,
			Size:        size,
			MimeType:    mimeType,
			CreatedAt:   o.CreatedAt,
			UpdatedAt:   o.UpdatedAt,
			StoragePath: fmt.Sprintf("%s/%s", bucket, o.Name),
		})
	}
	return files, nil
}

func (a *App) supaDeleteFile(fileName string) error {
	url := fmt.Sprintf("%s/storage/v1/object/%s/%s", a.supaURL, bucket, fileName)
	req, _ := http.NewRequest("DELETE", url, nil)
	a.supaHeaders(req)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (a *App) supaGetFileURL(fileName string) (string, error) {
	url := fmt.Sprintf("%s/storage/v1/object/sign/%s/%s", a.supaURL, bucket, fileName)
	req, _ := http.NewRequest("POST", url, strings.NewReader(`{"expiresIn":3600}`))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if signed, ok := result["signedURL"].(string); ok {
		return a.supaURL + signed, nil
	}
	return fmt.Sprintf("%s/storage/v1/object/public/%s/%s", a.supaURL, bucket, fileName), nil
}
