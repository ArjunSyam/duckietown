package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

//App config (vault path)

type Config struct {
	VaultPath string `json:"vault_path"`
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
