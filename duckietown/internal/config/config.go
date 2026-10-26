package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config is the per-user settings persisted to disk (vault path today).
type Config struct {
	VaultPath string `json:"vault_path"`
}

// Session is the persisted auth session (tokens survive app restarts).
type Session struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	UserID       string `json:"user_id"`
	Email        string `json:"email"`
}

func Dir() string {
	cfgDir, _ := os.UserConfigDir()
	dir := filepath.Join(cfgDir, "duckietown")
	os.MkdirAll(dir, 0755)
	return dir
}

func configPath(userID string) string {
	if userID == "" {
		return filepath.Join(Dir(), "config.json")
	}
	return filepath.Join(Dir(), fmt.Sprintf("config_%s.json", userID))
}

func LoadConfig(userID string) Config {
	data, err := os.ReadFile(configPath(userID))
	if err != nil {
		return Config{}
	}
	var cfg Config
	json.Unmarshal(data, &cfg)
	return cfg
}

func SaveConfig(userID string, cfg Config) {
	data, _ := json.Marshal(cfg)
	os.WriteFile(configPath(userID), data, 0644)
}

func sessionPath() string {
	return filepath.Join(Dir(), "session.json")
}

func LoadSession() Session {
	data, err := os.ReadFile(sessionPath())
	if err != nil {
		return Session{}
	}
	var s Session
	json.Unmarshal(data, &s)
	return s
}

func SaveSession(s Session) {
	data, _ := json.Marshal(s)
	os.WriteFile(sessionPath(), data, 0600) // 0600 = owner read/write only
}

func ClearSession() {
	os.Remove(sessionPath())
}
