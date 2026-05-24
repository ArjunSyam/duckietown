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
	client := &http.Client{Timeout: 3 * time.Second}
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

type moveRequest struct {
	OldName string `json:"old_name"`
	NewName string `json:"new_name"`
	UserID  string `json:"user_id"`
}

// GetIndexedFiles returns the set of file names already in ChromaDB.
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

// IngestFile embeds and stores a file in ChromaDB.
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

// MoveFileEmbeddings updates ChromaDB metadata when a file is renamed or moved.
// Reuses existing embeddings — no re-ingestion.
func (a *App) MoveFileEmbeddings(oldName, newName string) error {
	if a.userID == "" || !sidecarReady() {
		return nil
	}
	if oldName == newName {
		return nil
	}

	body, _ := json.Marshal(moveRequest{
		OldName: oldName,
		NewName: newName,
		UserID:  a.userID,
	})

	req, _ := http.NewRequest(http.MethodPatch, sidecarBase+"/ingest/move", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("move embeddings request failed: %w", err)
	}
	defer resp.Body.Close()
	fmt.Printf("🧠 Embeddings updated: %s → %s\n", oldName, newName)
	return nil
}

// DeleteFileEmbeddings removes all chunks for a file from ChromaDB.
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
