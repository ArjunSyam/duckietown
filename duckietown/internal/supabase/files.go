package supabase

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"duckietown/internal/config"
)

// FileRecord is the files-table row shape returned to the frontend.
type FileRecord struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	MimeType    string `json:"mime_type"`
	FolderPath  string `json:"folder_path"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	StoragePath string `json:"storage_path"`
}

type fileRow struct {
	ID          string `json:"id,omitempty"`
	UserID      string `json:"user_id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	MimeType    string `json:"mime_type"`
	StoragePath string `json:"storage_path"`
	FolderPath  string `json:"folder_path"`
	CreatedAt   string `json:"created_at,omitempty"`
	UpdatedAt   string `json:"updated_at,omitempty"`
}

// ── Upload ───────────────────────────────────────────────────────────────

func (c *Client) UploadFile(filePath, fileName, folderPath string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("read error: %w", err)
	}

	mimeType := config.MimeType(fileName)
	sp := c.StoragePath(fileName, folderPath)

	url := fmt.Sprintf("%s/storage/v1/object/%s/%s", c.URL, bucket, sp)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(data))
	c.headers(req)
	req.Header.Set("Content-Type", mimeType)
	req.Header.Set("x-upsert", "true")

	resp, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload failed [%d]: %s", resp.StatusCode, string(body))
	}

	return c.UpsertFileRecord(fileName, int64(len(data)), mimeType, sp, folderPath)
}

// ── Files table ──────────────────────────────────────────────────────────

func (c *Client) UpsertFileRecord(fileName string, size int64, mimeType, storagePath, folderPath string) error {
	row := fileRow{
		UserID:      c.UserID,
		Name:        fileName,
		Size:        size,
		MimeType:    mimeType,
		StoragePath: storagePath,
		FolderPath:  folderPath,
	}
	body, _ := json.Marshal(row)

	url := fmt.Sprintf("%s/rest/v1/files?on_conflict=user_id,name", c.URL)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	c.headers(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "resolution=merge-duplicates")

	resp, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("db error: %w", err)
	}
	defer resp.Body.Close()
	return nil
}

// UpdateFileFolderPath updates folder_path and storage_path for a moved/renamed file.
func (c *Client) UpdateFileFolderPath(fileName, newFolderPath, newStoragePath string) error {
	payload := map[string]string{
		"folder_path":  newFolderPath,
		"storage_path": newStoragePath,
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&name=eq.%s", c.URL, c.UserID, fileName)
	req, _ := http.NewRequest("PATCH", url, bytes.NewReader(body))
	c.headers(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

// RenameFileRecord updates the name, storage_path and folder_path for a renamed file.
func (c *Client) RenameFileRecord(oldName, newName, newFolderPath, newStoragePath string) error {
	payload := map[string]string{
		"name":         newName,
		"folder_path":  newFolderPath,
		"storage_path": newStoragePath,
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&name=eq.%s", c.URL, c.UserID, oldName)
	req, _ := http.NewRequest("PATCH", url, bytes.NewReader(body))
	c.headers(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (c *Client) DeleteFileRecord(fileName string) error {
	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&name=eq.%s", c.URL, c.UserID, fileName)
	req, _ := http.NewRequest("DELETE", url, nil)
	c.headers(req)
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

// ListFiles returns all files for the user including folder_path.
func (c *Client) ListFiles() ([]FileRecord, error) {
	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&order=updated_at.desc", c.URL, c.UserID)
	req, _ := http.NewRequest("GET", url, nil)
	c.headers(req)
	req.Header.Set("Accept", "application/json")

	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("supabase error [%d]: %s", resp.StatusCode, string(body))
	}

	var rows []fileRow
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return nil, fmt.Errorf("parse error: %w", err)
	}

	var files []FileRecord
	for _, r := range rows {
		files = append(files, FileRecord{
			ID:          r.ID,
			Name:        r.Name,
			Size:        r.Size,
			MimeType:    r.MimeType,
			StoragePath: r.StoragePath,
			FolderPath:  r.FolderPath,
			CreatedAt:   r.CreatedAt,
			UpdatedAt:   r.UpdatedAt,
		})
	}
	return files, nil
}

// ── Storage operations ──────────────────────────────────────────────────

func (c *Client) DeleteStorageFile(fileName, folderPath string) error {
	sp := c.StoragePath(fileName, folderPath)
	url := fmt.Sprintf("%s/storage/v1/object/%s/%s", c.URL, bucket, sp)
	req, _ := http.NewRequest("DELETE", url, nil)
	c.headers(req)
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (c *Client) GetFileURL(fileName, folderPath string) (string, error) {
	sp := c.StoragePath(fileName, folderPath)
	url := fmt.Sprintf("%s/storage/v1/object/sign/%s/%s", c.URL, bucket, sp)
	req, _ := http.NewRequest("POST", url, strings.NewReader(`{"expiresIn":3600}`))
	c.headers(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if signed, ok := result["signedURL"].(string); ok {
		return c.URL + signed, nil
	}
	return fmt.Sprintf("%s/storage/v1/object/public/%s/%s", c.URL, bucket, sp), nil
}

// ListStorageFiles returns all file names recursively under the user's
// prefix, e.g. "file.pdf", "work/invoice.pdf".
func (c *Client) ListStorageFiles() ([]string, error) {
	url := fmt.Sprintf("%s/storage/v1/object/list/%s", c.URL, bucket)
	body := fmt.Sprintf(`{"prefix":"%s/","limit":10000,"offset":0}`, c.UserID)
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	c.headers(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	var objects []struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&objects); err != nil {
		return nil, fmt.Errorf("parse error: %w", err)
	}

	var names []string
	for _, o := range objects {
		if o.Name == "" || o.Name == ".emptyFolderPlaceholder" {
			continue
		}
		name := strings.TrimPrefix(o.Name, c.UserID+"/")
		if name != "" {
			names = append(names, name)
		}
	}
	return names, nil
}
