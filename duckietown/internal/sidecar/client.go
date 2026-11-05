package sidecar

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const BaseURL = "http://127.0.0.1:8000"

func httpClientTimeout() time.Duration {
	return 120 * time.Second
}

// Ready reports whether the sidecar's /health endpoint is responding.
func Ready() bool {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(BaseURL + "/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

type ingestRequest struct {
	FilePath   string `json:"file_path"`
	FileName   string `json:"file_name"`
	UserID     string `json:"user_id"`
	FolderPath string `json:"folder_path"`
}

type deleteRequest struct {
	FileName string `json:"file_name"`
	UserID   string `json:"user_id"`
}

type moveRequest struct {
	OldName       string `json:"old_name"`
	NewName       string `json:"new_name"`
	NewFolderPath string `json:"new_folder_path"`
	UserID        string `json:"user_id"`
}

type enrichRequest struct {
	FilePath string `json:"file_path,omitempty"`
	FileName string `json:"file_name"`
	UserID   string `json:"user_id"`
}

// Client issues ingest/embedding requests to the sidecar on behalf of the
// signed-in user.
type Client struct {
	UserID string
}

func NewClient() *Client {
	return &Client{}
}

func (c *Client) SetUserID(userID string) {
	c.UserID = userID
}

// GetIndexedFiles returns the set of file names already in ChromaDB.
func (c *Client) GetIndexedFiles() (map[string]bool, error) {
	if !Ready() {
		return nil, fmt.Errorf("sidecar not ready")
	}
	url := fmt.Sprintf("%s/ingest/indexed?user_id=%s", BaseURL, c.UserID)
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
func (c *Client) IngestFile(filePath, fileName, folderPath string) error {
	if c.UserID == "" {
		return fmt.Errorf("not authenticated")
	}
	if !Ready() {
		fmt.Printf("⚠️ Sidecar not ready, skipping ingest for %s\n", fileName)
		return nil
	}

	body, _ := json.Marshal(ingestRequest{
		FilePath:   filePath,
		FileName:   fileName,
		UserID:     c.UserID,
		FolderPath: folderPath,
	})

	client := &http.Client{Timeout: httpClientTimeout()}
	resp, err := client.Post(BaseURL+"/ingest/file", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("ingest request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("ingest returned %d", resp.StatusCode)
	}
	return nil
}

// MoveFileEmbeddings updates ChromaDB metadata when a file is renamed or
// moved. Reuses existing embeddings — no re-ingestion.
func (c *Client) MoveFileEmbeddings(oldName, newName, newFolderPath string) error {
	if c.UserID == "" || !Ready() {
		return nil
	}
	if oldName == newName {
		return nil
	}

	body, _ := json.Marshal(moveRequest{
		OldName:       oldName,
		NewName:       newName,
		NewFolderPath: newFolderPath,
		UserID:        c.UserID,
	})

	req, _ := http.NewRequest(http.MethodPatch, BaseURL+"/ingest/move", bytes.NewReader(body))
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
func (c *Client) DeleteFileEmbeddings(fileName string) error {
	if c.UserID == "" || !Ready() {
		return nil
	}

	body, _ := json.Marshal(deleteRequest{
		FileName: fileName,
		UserID:   c.UserID,
	})

	req, _ := http.NewRequest(http.MethodDelete, BaseURL+"/ingest/file", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("delete embeddings request failed: %w", err)
	}
	defer resp.Body.Close()
	return nil
}

// GetFilesMissingProfiles returns file names already in ChromaDB that have
// no chunk_type="profile" chunk yet — used by the backfill/reindex action.
func (c *Client) GetFilesMissingProfiles() ([]string, error) {
	if !Ready() {
		return nil, fmt.Errorf("sidecar not ready")
	}
	url := fmt.Sprintf("%s/ingest/profiles-missing?user_id=%s", BaseURL, c.UserID)
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
	return result.Files, nil
}

// EnrichFile rebuilds a file's profile from chunks already in ChromaDB (no
// re-extraction, no re-embedding of body content). filePath may be empty
// if the file can't be resolved locally — enrichment still works from the
// indexed chunks alone, it just won't benefit the hash cache for that file.
// Returns the sidecar's status ("ok", "skipped", or "error") alongside err
// so callers (e.g. the backfill action) can distinguish "nothing to do"
// from an actual failure.
func (c *Client) EnrichFile(filePath, fileName string) (status string, err error) {
	if c.UserID == "" {
		return "", fmt.Errorf("not authenticated")
	}
	if !Ready() {
		return "", fmt.Errorf("sidecar not ready")
	}

	body, _ := json.Marshal(enrichRequest{
		FilePath: filePath,
		FileName: fileName,
		UserID:   c.UserID,
	})

	client := &http.Client{Timeout: httpClientTimeout()}
	resp, err := client.Post(BaseURL+"/ingest/enrich", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("enrich request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("enrich returned %d", resp.StatusCode)
	}

	var result struct {
		Status string `json:"status"`
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode enrich response: %w", err)
	}
	if result.Status == "error" {
		return result.Status, fmt.Errorf("enrich failed: %s", result.Detail)
	}
	return result.Status, nil
}
