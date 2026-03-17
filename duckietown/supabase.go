package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const bucket = "duckietown"

// supaHeaders sets auth headers using the user's access token
// Falls back to anon key for non-authed requests
func (a *App) supaHeaders(req *http.Request) {
	req.Header.Set("apikey", a.supaKey)
	if a.accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+a.accessToken)
	} else {
		req.Header.Set("Authorization", "Bearer "+a.supaKey)
	}
}

// storagePath returns the user-scoped storage path: {user_id}/{filename}
func (a *App) storagePath(fileName string) string {
	return fmt.Sprintf("%s/%s", a.userID, fileName)
}

// Upload

func (a *App) supaUploadFile(filePath, fileName string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("read error: %w", err)
	}

	mimeType := getMimeType(fileName)
	storagePath := a.storagePath(fileName)

	// Upload to storage bucket at {user_id}/{filename}
	url := fmt.Sprintf("%s/storage/v1/object/%s/%s", a.supaURL, bucket, storagePath)
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

	// Upsert metadata row into files table
	fileSize := int64(len(data))
	return a.supaUpsertFileRecord(fileName, fileSize, mimeType, storagePath)
}

// Files table

type supaFileRow struct {
	ID          string `json:"id,omitempty"`
	UserID      string `json:"user_id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	MimeType    string `json:"mime_type"`
	StoragePath string `json:"storage_path"`
	CreatedAt   string `json:"created_at,omitempty"`
	UpdatedAt   string `json:"updated_at,omitempty"`
}

func (a *App) supaUpsertFileRecord(fileName string, size int64, mimeType, storagePath string) error {
	row := supaFileRow{
		UserID:      a.userID,
		Name:        fileName,
		Size:        size,
		MimeType:    mimeType,
		StoragePath: storagePath,
	}
	body, _ := json.Marshal(row)

	// POST with onConflict=user_id,name to upsert
	url := fmt.Sprintf("%s/rest/v1/files?on_conflict=user_id,name", a.supaURL)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "resolution=merge-duplicates")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("db error: %w", err)
	}
	defer resp.Body.Close()
	return nil
}

func (a *App) supaDeleteFileRecord(fileName string) error {
	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&name=eq.%s",
		a.supaURL, a.userID, fileName)
	req, _ := http.NewRequest("DELETE", url, nil)
	a.supaHeaders(req)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

// List files

func (a *App) supaListFiles() ([]FileRecord, error) {
	// Query files table filtered by user_id (RLS also enforces this)
	url := fmt.Sprintf("%s/rest/v1/files?user_id=eq.%s&order=updated_at.desc",
		a.supaURL, a.userID)
	req, _ := http.NewRequest("GET", url, nil)
	a.supaHeaders(req)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

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
			CreatedAt:   r.CreatedAt,
			UpdatedAt:   r.UpdatedAt,
		})
	}
	return files, nil
}

// Storage operations

func (a *App) supaDeleteStorageFile(fileName string) error {
	storagePath := a.storagePath(fileName)
	url := fmt.Sprintf("%s/storage/v1/object/%s/%s", a.supaURL, bucket, storagePath)
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
	storagePath := a.storagePath(fileName)
	url := fmt.Sprintf("%s/storage/v1/object/sign/%s/%s", a.supaURL, bucket, storagePath)
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
	return fmt.Sprintf("%s/storage/v1/object/public/%s/%s",
		a.supaURL, bucket, storagePath), nil
}

func (a *App) supaListStorageFiles() ([]string, error) {
	url := fmt.Sprintf("%s/storage/v1/object/list/%s", a.supaURL, bucket)
	body := fmt.Sprintf(`{"prefix":"%s/","limit":1000,"offset":0}`, a.userID)
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	a.supaHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
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
