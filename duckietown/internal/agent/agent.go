// Package agent implements AI-facing features that talk to the sidecar's
// /search/* endpoints: semantic search, RAG chat, and organize-intent
// parsing/execution. Organize needs to search and move files, so this
// package depends on vault.
package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"duckietown/internal/sidecar"
	"duckietown/internal/vault"
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

type OrganiseIntent struct {
	IsOrganise bool   `json:"is_organise"`
	Query      string `json:"query"`
	FolderName string `json:"folder_name"`
	TypeFilter string `json:"type_filter"`
	Error      string `json:"error,omitempty"`
}

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

type OrganiseFolderResult struct {
	FolderName string   `json:"folder_name"`
	Files      []string `json:"files"`
	Created    bool     `json:"created"`
	Error      string   `json:"error,omitempty"`
}

// Service implements semantic search, chat, and organize. It needs the
// vault service because organize has to search, create a folder, and
// move matching files within the vault.
type Service struct {
	ctx    context.Context
	UserID string
	Vault  *vault.Service
}

func NewService(v *vault.Service) *Service {
	return &Service{Vault: v}
}

func (s *Service) SetContext(ctx context.Context) {
	s.ctx = ctx
}

func (s *Service) SetUser(userID string) {
	s.UserID = userID
}

func (s *Service) SemanticSearch(query string, topK int) ([]SearchResult, error) {
	if s.UserID == "" {
		return nil, fmt.Errorf("not authenticated")
	}
	if !sidecar.Ready() {
		return nil, fmt.Errorf("AI search not available — sidecar not running")
	}
	if topK <= 0 {
		topK = 50
	}
	body, _ := json.Marshal(queryRequest{Query: query, UserID: s.UserID, TopK: topK})
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Post(sidecar.BaseURL+"/search/query", "application/json", bytes.NewReader(body))
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

func (s *Service) semanticSearchWithTypeFilter(query, typeFilter string, topK int) ([]SearchResult, error) {
	if s.UserID == "" {
		return nil, fmt.Errorf("not authenticated")
	}
	if !sidecar.Ready() {
		return nil, fmt.Errorf("AI search not available")
	}
	if topK <= 0 {
		topK = 200
	}
	body, _ := json.Marshal(queryRequest{
		Query:      query,
		UserID:     s.UserID,
		TopK:       topK,
		TypeFilter: typeFilter,
	})
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Post(sidecar.BaseURL+"/search/query", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result queryResponse
	json.NewDecoder(resp.Body).Decode(&result)
	return result.Results, nil
}

// GetChatModel returns the OpenRouter model id actually in use for chat,
// so the frontend can display the real model instead of a hardcoded label.
func (s *Service) GetChatModel() (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(sidecar.BaseURL + "/search/model")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return result.Model, nil
}

// ParseOrganiseIntent calls the sidecar to determine if a message is an
// organise request and extracts its structured parameters.
func (s *Service) ParseOrganiseIntent(message string) (OrganiseIntent, error) {
	body, _ := json.Marshal(map[string]string{
		"message": message,
		"user_id": s.UserID,
	})
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Post(sidecar.BaseURL+"/search/organise-intent", "application/json", bytes.NewReader(body))
	if err != nil {
		return OrganiseIntent{}, err
	}
	defer resp.Body.Close()

	var intent OrganiseIntent
	json.NewDecoder(resp.Body).Decode(&intent)
	return intent, nil
}

// ChatWithAgent streams a RAG chat response back to the frontend via
// Wails events (chat-sources, chat-token*, chat-done/chat-error).
func (s *Service) ChatWithAgent(message string, history []ChatMessage, fileName string) {
	if s.UserID == "" {
		wailsruntime.EventsEmit(s.ctx, "chat-error", "not authenticated")
		return
	}
	body, _ := json.Marshal(chatRequest{
		Message:  message,
		UserID:   s.UserID,
		History:  history,
		FileName: fileName,
	})

	go func() {
		client := &http.Client{Timeout: 120 * time.Second}
		resp, err := client.Post(sidecar.BaseURL+"/search/chat", "application/json", bytes.NewReader(body))
		if err != nil {
			wailsruntime.EventsEmit(s.ctx, "chat-error", err.Error())
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
				wailsruntime.EventsEmit(s.ctx, "chat-error", err.Error())
				return
			}
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			raw := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if raw == "[DONE]" {
				wailsruntime.EventsEmit(s.ctx, "chat-done", nil)
				return
			}
			var event map[string]interface{}
			if err := json.Unmarshal([]byte(raw), &event); err != nil {
				continue
			}
			switch event["type"] {
			case "token":
				if content, ok := event["content"].(string); ok {
					wailsruntime.EventsEmit(s.ctx, "chat-token", map[string]string{
						"content": content,
					})
				}
			case "sources":
				wailsruntime.EventsEmit(s.ctx, "chat-sources", event["files"])
			case "error":
				// Don't return here — the sidecar always follows an error
				// event with a trailing [DONE] on the same stream (either
				// immediately, or once the stream naturally ends). Keep
				// reading so that line is processed and chat-done still
				// fires; otherwise the frontend's streaming indicator for
				// this message never clears.
				wailsruntime.EventsEmit(s.ctx, "chat-error", event["content"])
			}
		}
		wailsruntime.EventsEmit(s.ctx, "chat-done", nil)
	}()
}

// OrganiseFolder finds files matching a query across the ENTIRE vault (all
// subfolders), creates the target folder, and moves matching files into it.
// typeFilter: "image", "text", "audio", "video", or "" for semantic-only.
func (s *Service) OrganiseFolder(currentFolderPath, query, newFolderName, typeFilter string) (OrganiseFolderResult, error) {
	result := OrganiseFolderResult{FolderName: newFolderName}

	if s.UserID == "" {
		return result, fmt.Errorf("not authenticated")
	}

	// Semantic search across all files
	matches, err := s.semanticSearchWithTypeFilter(query, typeFilter, 200)
	if err != nil {
		return result, fmt.Errorf("search failed: %w", err)
	}

	// For type-based organise, also scan vault directly to catch files
	// not yet in ChromaDB or with similarity below threshold
	if typeFilter != "" {
		localMatches := s.Vault.FindFilesByType(typeFilter)
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

	if err := s.Vault.CreateFolder(targetPath); err != nil {
		return result, fmt.Errorf("could not create folder: %w", err)
	}
	result.Created = true

	var movedFiles []string
	for _, match := range matches {
		_, currentFolder, err := s.Vault.FindFileInVault(match.FileName)
		if err != nil {
			continue
		}
		if currentFolder == targetPath {
			continue // already there
		}
		if err := s.Vault.MoveFileToFolder(match.FileName, targetPath); err != nil {
			fmt.Printf("⚠️ Could not move %s: %v\n", match.FileName, err)
			continue
		}
		movedFiles = append(movedFiles, match.FileName)
	}
	result.Files = movedFiles

	wailsruntime.EventsEmit(s.ctx, "organise-complete", result)
	fmt.Printf("✅ Organised %d files into %s\n", len(movedFiles), targetPath)
	return result, nil
}
