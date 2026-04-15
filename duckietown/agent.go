package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	Query  string `json:"query"`
	UserID string `json:"user_id"`
	TopK   int    `json:"top_k"`
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

// ChatMessage is shared between Go and the frontend.
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

// ChatWithAgent streams a RAG chat response back to the frontend via Wails events.
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

// OrganiseFolderResult describes the outcome of an AI-driven organisation.
type OrganiseFolderResult struct {
	FolderName string   `json:"folder_name"`
	Files      []string `json:"files"`
	Created    bool     `json:"created"`
	Error      string   `json:"error,omitempty"`
}

// OrganiseFolder uses semantic search to find files matching a query, creates a
// subfolder with the given name, and moves matching files into it.
// Exposed to frontend via Wails.
// Example: OrganiseFolder("work/projects", "cat photos", "cats")
//
//	→ searches for files similar to "cat photos"
//	→ creates folder "work/projects/cats"
//	→ moves matching files there
func (a *App) OrganiseFolder(currentFolderPath, query, newFolderName string) (OrganiseFolderResult, error) {
	result := OrganiseFolderResult{FolderName: newFolderName}

	if a.userID == "" {
		return result, fmt.Errorf("not authenticated")
	}

	// Semantic search for matching files
	matches, err := a.SemanticSearch(query, 50)
	if err != nil {
		return result, fmt.Errorf("search failed: %w", err)
	}
	if len(matches) == 0 {
		return result, fmt.Errorf("no matching files found for query: %s", query)
	}

	// Build target folder path
	var targetPath string
	if currentFolderPath == "" {
		targetPath = newFolderName
	} else {
		targetPath = currentFolderPath + "/" + newFolderName
	}

	// Create the folder
	if err := a.CreateFolder(targetPath); err != nil {
		return result, fmt.Errorf("could not create folder: %w", err)
	}
	result.Created = true

	// Move each matched file into the new folder
	var movedFiles []string
	for _, match := range matches {
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
