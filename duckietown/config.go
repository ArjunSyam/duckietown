package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//App config (vault path)

type Config struct {
	VaultPath string `json:"vault_path"`
}

type refreshResponse struct {
	AccessToken  string   `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	User         AuthUser `json:"user"`
}

func configDir() string {
	cfgDir, _ := os.UserConfigDir()
	dir := filepath.Join(cfgDir, "duckietown")
	os.MkdirAll(dir, 0755)
	return dir
}

func configPath(userID string) string {
	if userID == "" {
		return filepath.Join(configDir(), "config.json")
	}
	return filepath.Join(configDir(), fmt.Sprintf("config_%s.json", userID))
}

func loadConfig(userID string) Config {
	data, err := os.ReadFile(configPath(userID))
	if err != nil {
		return Config{}
	}
	var cfg Config
	json.Unmarshal(data, &cfg)
	return cfg
}

func saveConfig(userID string, cfg Config) {
	data, _ := json.Marshal(cfg)
	os.WriteFile(configPath(userID), data, 0644)
}

//Session (auth tokens)

type Session struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	UserID       string `json:"user_id"`
	Email        string `json:"email"`
}

func sessionPath() string {
	return filepath.Join(configDir(), "session.json")
}

func loadSession() Session {
	data, err := os.ReadFile(sessionPath())
	if err != nil {
		return Session{}
	}
	var s Session
	json.Unmarshal(data, &s)
	return s
}

func saveSession(s Session) {
	data, _ := json.Marshal(s)
	os.WriteFile(sessionPath(), data, 0600) // 0600 = owner read/write only
}

func clearSession() {
	os.Remove(sessionPath())
}

func (a *App) refreshSession() error {
	if a.refreshToken == "" {
		return fmt.Errorf("no refresh token available")
	}

	url := fmt.Sprintf("%s/auth/v1/token?grant_type=refresh_token", a.supaURL)
	payload, _ := json.Marshal(map[string]string{
		"refresh_token": a.refreshToken,
	})

	req, _ := http.NewRequest("POST", url, strings.NewReader(string(payload)))
	req.Header.Set("apikey", a.supaKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to refresh token: %d", resp.StatusCode)
	}

	var res refreshResponse

	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return err
	}

	// Update memory
	a.accessToken = res.AccessToken
	a.refreshToken = res.RefreshToken

	// Persist updated tokens to disk
	saveSession(Session{
		AccessToken:  res.AccessToken,
		RefreshToken: res.RefreshToken,
		UserID:       a.userID,
		Email:        a.email,
	})

	return nil
}
