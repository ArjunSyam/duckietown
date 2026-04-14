package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const sidecarBase = "http://127.0.0.1:8000"

func httpClientTimeout() time.Duration {
	return 120 * time.Second
}

func sidecarReady() bool {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get(sidecarBase + "/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

type ingestRequest struct {
	FilePath string `json:"file_path"`
	FileName string `json:"file_name"`
	UserID   string `json:"user_id"`
}

type deleteRequest struct {
	FileName string `json:"file_name"`
	UserID   string `json:"user_id"`
}

func (a *App) GetIndexedFiles() (map[string]bool, error) {
	if !sidecarReady() {
		return nil, fmt.Errorf("sidecar not ready")
	}
	url := fmt.Sprintf("%s/ingest/indexed?user_id=%s", sidecarBase, a.userID)
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result struct {
		Files []string `json:"files"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	indexed := make(map[string]bool, len(result.Files))
	for _, f := range result.Files {
		indexed[f] = true
	}
	return indexed, nil
}

func (a *App) IngestFile(filePath, fileName string) error {
	if a.userID == "" {
		return fmt.Errorf("not authenticated")
	}
	if !sidecarReady() {
		fmt.Printf("⚠️ Sidecar not ready, skipping ingest for %s\n", fileName)
		return nil
	}

	body, _ := json.Marshal(ingestRequest{
		FilePath: filePath,
		FileName: fileName,
		UserID:   a.userID,
	})

	client := &http.Client{Timeout: httpClientTimeout()}
	resp, err := client.Post(sidecarBase+"/ingest/file", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("ingest request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("ingest returned %d", resp.StatusCode)
	}
	return nil
}

func (a *App) DeleteFileEmbeddings(fileName string) error {
	if a.userID == "" || !sidecarReady() {
		return nil
	}

	body, _ := json.Marshal(deleteRequest{
		FileName: fileName,
		UserID:   a.userID,
	})

	req, _ := http.NewRequest(http.MethodDelete, sidecarBase+"/ingest/file", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("delete embeddings request failed: %w", err)
	}
	defer resp.Body.Close()
	return nil
}
