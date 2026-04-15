package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

const bucket = "duckietown"

func (a *App) supaHeaders(req *http.Request) {
	req.Header.Set("apikey", a.supaKey)
	if req.Header.Get("Authorization") != "" {
		return
	}
	if a.accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+a.accessToken)
		return
	}
	req.Header.Set("Authorization", "Bearer "+a.supaKey)
}

// storagePath returns {user_id}/{folder_path}/{filename}
// folderPath is "" for root files
func (a *App) storagePath(fileName, folderPath string) string {
	if folderPath == "" {
		return fmt.Sprintf("%s/%s", a.userID, fileName)
	}
	return fmt.Sprintf("%s/%s/%s", a.userID, folderPath, fileName)
}

// ── Upload ─────────────────────────────────────────────────────────────────────

func (a *App) supaUploadFile(filePath, fileName, folderPath string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("read error: %w", err)
	}

	mimeType := getMimeType(fileName)
	sp := a.storagePath(fileName, folderPath)

	url := fmt.Sprintf("%s/storage/v1/object/%s/%s", a.supaURL, bucket, sp)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(data))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", mimeType)
	req.Header.Set("x-upsert", "true")

	resp, err := a.supaDo(req)
	if err != nil {
		return fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload failed [%d]: %s", resp.StatusCode, string(body))
	}

	return a.supaUpsertFileRecord(fileName, int64(len(data)), mimeType, sp, folderPath)
}

// ── Files table ────────────────────────────────────────────────────────────────

type supaFileRow struct {
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

func (a *App) supaUpsertFileRecord(fileName string, size int64, mimeType, storagePath, folderPath string) error {
	row := supaFileRow{
		UserID:      a.userID,
		Name:        fileName,
		Size:        size,
		MimeType:    mimeType,
		StoragePath: storagePath,
		FolderPath:  folderPath,
	}
	body, _ := json.Marshal(row)

	url := fmt.Sprintf("%s/rest/v1/files?on_conflict=user_id,name", a.supaURL)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "resolution=merge-duplicates")

	resp, err := a.supaDo(req)
	if err != nil {
		return fmt.Errorf("db error: %w", err)
	}
	defer resp.Body.Close()
	return nil
}

// supaUpdateFileFolderPath updates folder_path and storage_path for a moved/renamed file.
func (a *App) supaUpdateFileFolderPath(fileName, newFolderPath, newStoragePath string) error {
	payload := map[string]string{
		"folder_path":  newFolderPath,
		"storage_path": newStoragePath,
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&name=eq.%s",
		a.supaURL, a.userID, fileName)
	req, _ := http.NewRequest("PATCH", url, bytes.NewReader(body))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.supaDo(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

// supaRenameFileRecord updates the name, storage_path and folder_path for a renamed file.
func (a *App) supaRenameFileRecord(oldName, newName, newFolderPath, newStoragePath string) error {
	payload := map[string]string{
		"name":         newName,
		"folder_path":  newFolderPath,
		"storage_path": newStoragePath,
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&name=eq.%s",
		a.supaURL, a.userID, oldName)
	req, _ := http.NewRequest("PATCH", url, bytes.NewReader(body))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.supaDo(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (a *App) supaDeleteFileRecord(fileName string) error {
	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&name=eq.%s",
		a.supaURL, a.userID, fileName)
	req, _ := http.NewRequest("DELETE", url, nil)
	a.supaHeaders(req)
	resp, err := a.supaDo(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

// supaListFiles returns all files for the user including folder_path.
func (a *App) supaListFiles() ([]FileRecord, error) {
	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&order=updated_at.desc",
		a.supaURL, a.userID)
	req, _ := http.NewRequest("GET", url, nil)
	a.supaHeaders(req)
	req.Header.Set("Accept", "application/json")

	resp, err := a.supaDo(req)
	if err != nil {
		return nil, fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("supabase error [%d]: %s", resp.StatusCode, string(body))
	}

	var rows []supaFileRow
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

// ── Storage operations ─────────────────────────────────────────────────────────

func (a *App) supaDeleteStorageFile(fileName, folderPath string) error {
	sp := a.storagePath(fileName, folderPath)
	url := fmt.Sprintf("%s/storage/v1/object/%s/%s", a.supaURL, bucket, sp)
	req, _ := http.NewRequest("DELETE", url, nil)
	a.supaHeaders(req)
	resp, err := a.supaDo(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (a *App) supaGetFileURL(fileName, folderPath string) (string, error) {
	sp := a.storagePath(fileName, folderPath)
	url := fmt.Sprintf("%s/storage/v1/object/sign/%s/%s", a.supaURL, bucket, sp)
	req, _ := http.NewRequest("POST", url, strings.NewReader(`{"expiresIn":3600}`))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.supaDo(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if signed, ok := result["signedURL"].(string); ok {
		return a.supaURL + signed, nil
	}
	return fmt.Sprintf("%s/storage/v1/object/public/%s/%s", a.supaURL, bucket, sp), nil
}

// supaListStorageFiles returns all file names recursively under the user's prefix.
// Returns relative paths from user root e.g. "file.pdf", "work/invoice.pdf"
func (a *App) supaListStorageFiles() ([]string, error) {
	url := fmt.Sprintf("%s/storage/v1/object/list/%s", a.supaURL, bucket)
	body := fmt.Sprintf(`{"prefix":"%s/","limit":10000,"offset":0}`, a.userID)
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.supaDo(req)
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
		name := strings.TrimPrefix(o.Name, a.userID+"/")
		if name != "" {
			names = append(names, name)
		}
	}
	return names, nil
}
