package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type SearchResult struct {
	FileName   string  `json:"file_name"`
	Similarity float64 `json:"similarity"`
	Snippet    string  `json:"snippet"`
	Modality   string  `json:"modality"`
	Page       string  `json:"page"`
}

type queryRequest struct {
	Query      string `json:"query"`
	UserID     string `json:"user_id"`
	TopK       int    `json:"top_k"`
	TypeFilter string `json:"type_filter,omitempty"`
}

type queryResponse struct {
	Results      []SearchResult `json:"results"`
	TotalIndexed int            `json:"total_indexed"`
	Error        string         `json:"error,omitempty"`
}

func (a *App) SemanticSearch(query string, topK int) ([]SearchResult, error) {
	if a.userID == "" {
		return nil, fmt.Errorf("not authenticated")
	}
	if !sidecarReady() {
		return nil, fmt.Errorf("AI search not available — sidecar not running")
	}
	if topK <= 0 {
		topK = 50
	}
	body, _ := json.Marshal(queryRequest{Query: query, UserID: a.userID, TopK: topK})
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Post(sidecarBase+"/search/query", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("search request failed: %w", err)
	}
	defer resp.Body.Close()

	var result queryResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode search response: %w", err)
	}
	if result.Error != "" {
		return nil, fmt.Errorf("search error: %s", result.Error)
	}
	return result.Results, nil
}

func (a *App) semanticSearchWithTypeFilter(query, typeFilter string, topK int) ([]SearchResult, error) {
	if a.userID == "" {
		return nil, fmt.Errorf("not authenticated")
	}
	if !sidecarReady() {
		return nil, fmt.Errorf("AI search not available")
	}
	if topK <= 0 {
		topK = 200
	}
	body, _ := json.Marshal(queryRequest{
		Query:      query,
		UserID:     a.userID,
		TopK:       topK,
		TypeFilter: typeFilter,
	})
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Post(sidecarBase+"/search/query", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result queryResponse
	json.NewDecoder(resp.Body).Decode(&result)
	return result.Results, nil
}

// ── Organise intent ────────────────────────────────────────────────────────────

type OrganiseIntent struct {
	IsOrganise bool   `json:"is_organise"`
	Query      string `json:"query"`
	FolderName string `json:"folder_name"`
	TypeFilter string `json:"type_filter"`
	Error      string `json:"error,omitempty"`
}

// ParseOrganiseIntent calls the sidecar to determine if a message is an organise
// request and extracts its structured parameters. Exposed to frontend via Wails.
func (a *App) ParseOrganiseIntent(message string) (OrganiseIntent, error) {
	if !sidecarReady() {
		return OrganiseIntent{}, fmt.Errorf("sidecar not ready")
	}
	body, _ := json.Marshal(map[string]string{
		"message": message,
		"user_id": a.userID,
	})
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Post(sidecarBase+"/search/organise-intent", "application/json", bytes.NewReader(body))
	if err != nil {
		return OrganiseIntent{}, err
	}
	defer resp.Body.Close()

	var intent OrganiseIntent
	json.NewDecoder(resp.Body).Decode(&intent)
	return intent, nil
}

// ── Chat ───────────────────────────────────────────────────────────────────────

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Message  string        `json:"message"`
	UserID   string        `json:"user_id"`
	History  []ChatMessage `json:"history"`
	FileName string        `json:"file_name,omitempty"`
}

func (a *App) ChatWithAgent(message string, history []ChatMessage, fileName string) {
	if a.userID == "" {
		wailsruntime.EventsEmit(a.ctx, "chat-error", "not authenticated")
		return
	}
	if !sidecarReady() {
		wailsruntime.EventsEmit(a.ctx, "chat-error", "AI not available — sidecar not running")
		return
	}

	body, _ := json.Marshal(chatRequest{
		Message:  message,
		UserID:   a.userID,
		History:  history,
		FileName: fileName,
	})

	go func() {
		client := &http.Client{Timeout: 120 * time.Second}
		resp, err := client.Post(sidecarBase+"/search/chat", "application/json", bytes.NewReader(body))
		if err != nil {
			wailsruntime.EventsEmit(a.ctx, "chat-error", err.Error())
			return
		}
		defer resp.Body.Close()

		reader := bufio.NewReader(resp.Body)
		for {
			line, err := reader.ReadString('\n')
			if err == io.EOF {
				break
			}
			if err != nil {
				wailsruntime.EventsEmit(a.ctx, "chat-error", err.Error())
				return
			}
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			raw := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if raw == "[DONE]" {
				wailsruntime.EventsEmit(a.ctx, "chat-done", nil)
				return
			}
			var event map[string]interface{}
			if err := json.Unmarshal([]byte(raw), &event); err != nil {
				continue
			}
			switch event["type"] {
			case "token":
				wailsruntime.EventsEmit(a.ctx, "chat-token", map[string]string{
					"content": event["content"].(string),
				})
			case "sources":
				wailsruntime.EventsEmit(a.ctx, "chat-sources", event["files"])
			}
		}
		wailsruntime.EventsEmit(a.ctx, "chat-done", nil)
	}()
}

// ── Organise ───────────────────────────────────────────────────────────────────

type OrganiseFolderResult struct {
	FolderName string   `json:"folder_name"`
	Files      []string `json:"files"`
	Created    bool     `json:"created"`
	Error      string   `json:"error,omitempty"`
}

// OrganiseFolder finds files matching a query across the ENTIRE vault (all subfolders),
// creates the target folder, and moves matching files into it.
// typeFilter: "image", "text", "audio", "video", or "" for semantic-only.
// Exposed to frontend via Wails.
func (a *App) OrganiseFolder(currentFolderPath, query, newFolderName, typeFilter string) (OrganiseFolderResult, error) {
	result := OrganiseFolderResult{FolderName: newFolderName}

	if a.userID == "" {
		return result, fmt.Errorf("not authenticated")
	}

	// Semantic search across all files
	matches, err := a.semanticSearchWithTypeFilter(query, typeFilter, 200)
	if err != nil {
		return result, fmt.Errorf("search failed: %w", err)
	}

	// For type-based organise, also scan vault directly to catch files
	// not yet in ChromaDB or with similarity below threshold
	if typeFilter != "" {
		localMatches := a.findFilesByType(typeFilter)
		existing := make(map[string]bool)
		for _, m := range matches {
			existing[m.FileName] = true
		}
		for _, name := range localMatches {
			if !existing[name] {
				matches = append(matches, SearchResult{
					FileName:   name,
					Similarity: 0.5,
					Modality:   typeFilter,
				})
			}
		}
	}

	if len(matches) == 0 {
		return result, fmt.Errorf("no matching files found for: %s", query)
	}

	// Build target path
	targetPath := newFolderName
	if currentFolderPath != "" {
		targetPath = currentFolderPath + "/" + newFolderName
	}

	if err := a.CreateFolder(targetPath); err != nil {
		return result, fmt.Errorf("could not create folder: %w", err)
	}
	result.Created = true

	var movedFiles []string
	for _, match := range matches {
		_, currentFolder, err := a.findFileInVault(match.FileName)
		if err != nil {
			continue
		}
		if currentFolder == targetPath {
			continue // already there
		}
		if err := a.MoveFileToFolder(match.FileName, targetPath); err != nil {
			fmt.Printf("⚠️ Could not move %s: %v\n", match.FileName, err)
			continue
		}
		movedFiles = append(movedFiles, match.FileName)
	}
	result.Files = movedFiles

	wailsruntime.EventsEmit(a.ctx, "organise-complete", result)
	fmt.Printf("✅ Organised %d files into %s\n", len(movedFiles), targetPath)
	return result, nil
}

// findFilesByType scans the entire vault and returns filenames matching a modality.
func (a *App) findFilesByType(typeFilter string) []string {
	imageExts := map[string]bool{
		".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
		".webp": true, ".bmp": true, ".svg": true, ".heic": true, ".tiff": true,
	}
	audioExts := map[string]bool{
		".mp3": true, ".wav": true, ".aac": true, ".flac": true,
		".ogg": true, ".m4a": true, ".wma": true,
	}
	videoExts := map[string]bool{
		".mp4": true, ".mov": true, ".avi": true, ".mkv": true,
		".webm": true, ".wmv": true, ".m4v": true,
	}
	textExts := map[string]bool{
		".pdf": true, ".doc": true, ".docx": true, ".txt": true,
		".md": true, ".xlsx": true, ".xls": true, ".csv": true,
		".pptx": true, ".ppt": true, ".rtf": true,
	}

	var extMap map[string]bool
	switch typeFilter {
	case "image":
		extMap = imageExts
	case "audio":
		extMap = audioExts
	case "video":
		extMap = videoExts
	case "text":
		extMap = textExts
	default:
		return nil
	}

	var names []string
	filepath.WalkDir(a.vaultPath, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if shouldSkipFile(name) {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(name))
		if extMap[ext] {
			names = append(names, name)
		}
		return nil
	})
	return names
}

// getFileExt returns the lowercase extension of a filename including the dot.
func getFileExt(name string) string {
	return strings.ToLower(filepath.Ext(name))
}
