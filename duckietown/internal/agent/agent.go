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
	"path/filepath"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"duckietown/internal/sidecar"
	"duckietown/internal/vault"
)

type SearchResult struct {
	FileName   string  `json:"file_name"`
	Similarity float64 `json:"similarity"`
	Score      float64 `json:"score,omitempty"`
	Snippet    string  `json:"snippet"`
	Modality   string  `json:"modality"`
	Page       string  `json:"page"`
	FolderPath string  `json:"folder_path,omitempty"`
	MimeType   string  `json:"mime_type,omitempty"`
	Summary    string  `json:"summary,omitempty"`
	Category   string  `json:"category,omitempty"`
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

// fileMove records where a file was before an OrganiseFolder moved it, so
// the move can be undone later.
type fileMove struct {
	FileName   string
	FromFolder string
}

// organiseRecord is the most recent OrganiseFolder run, kept around just
// long enough to support a single "undo that" — consumed (cleared) the
// moment it's undone, or replaced by the next organise call.
type organiseRecord struct {
	TargetFolder string
	Moves        []fileMove
}

// Service implements semantic search, chat, and organize. It needs the
// vault service because organize has to search, create a folder, and
// move matching files within the vault.
type Service struct {
	ctx    context.Context
	UserID string
	Vault  *vault.Service

	lastOrganise  *organiseRecord
	organisePlans *planStore[*OrganisePlan]
	renamePlans   *planStore[*RenamePlan]
}

func NewService(v *vault.Service) *Service {
	return &Service{
		Vault:         v,
		organisePlans: newPlanStore[*OrganisePlan](),
		renamePlans:   newPlanStore[*RenamePlan](),
	}
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
			case "tool_start":
				wailsruntime.EventsEmit(s.ctx, "chat-tool-start", map[string]string{
					"tool":  fmt.Sprint(event["tool"]),
					"label": fmt.Sprint(event["label"]),
				})
			case "search_results":
				wailsruntime.EventsEmit(s.ctx, "chat-search-results", event["results"])
			case "organise_proposal":
				s.handleOrganiseProposalFromChat(event)
			case "rename_proposal":
				s.handleRenameProposalFromChat(event)
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
	var moves []fileMove
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
		moves = append(moves, fileMove{FileName: match.FileName, FromFolder: currentFolder})
	}
	result.Files = movedFiles

	if len(moves) > 0 {
		s.lastOrganise = &organiseRecord{TargetFolder: targetPath, Moves: moves}
	}

	wailsruntime.EventsEmit(s.ctx, "organise-complete", result)
	fmt.Printf("✅ Organised %d files into %s\n", len(movedFiles), targetPath)
	return result, nil
}

// UndoLastOrganise moves every file from the most recent OrganiseFolder call
// back to the folder it was in before, then forgets that record — it's a
// one-shot undo, not a full history. Does not attempt to delete the folder
// OrganiseFolder created, even if it's now empty: the user may have added
// something else to it since, and removing a folder out from under them
// unasked is a worse mistake than leaving an empty one behind.
func (s *Service) UndoLastOrganise() (OrganiseFolderResult, error) {
	result := OrganiseFolderResult{}
	rec := s.lastOrganise
	if rec == nil {
		return result, fmt.Errorf("nothing to undo")
	}
	s.lastOrganise = nil
	result.FolderName = rec.TargetFolder

	var restored []string
	for _, mv := range rec.Moves {
		if err := s.Vault.MoveFileToFolder(mv.FileName, mv.FromFolder); err != nil {
			fmt.Printf("⚠️ Could not undo move for %s: %v\n", mv.FileName, err)
			continue
		}
		restored = append(restored, mv.FileName)
	}
	result.Files = restored

	wailsruntime.EventsEmit(s.ctx, "organise-complete", result)
	fmt.Printf("↩️ Undid organise: restored %d file(s) from %s\n", len(restored), rec.TargetFolder)
	return result, nil
}

// ── Organise flow v2: search → judge → preview → confirm → move ────────

// ProposedGrouping is one suggested folder+description returned when an
// instruction was too vague to act on directly (e.g. "organise everything").
type ProposedGrouping struct {
	FolderName  string `json:"folder_name"`
	Description string `json:"description"`
}

// OrganisePreview is what ProposeOrganise returns to the frontend: either a
// ready-to-confirm plan, or a request for the user to pick one of several
// proposed groupings.
type OrganisePreview struct {
	PlanID             string             `json:"plan_id,omitempty"`
	TargetFolder       string             `json:"target_folder,omitempty"`
	Moves              []PlannedMove      `json:"moves,omitempty"`
	NeedsClarification bool               `json:"needs_clarification"`
	ProposedGroupings  []ProposedGrouping `json:"proposed_groupings,omitempty"`
	Error              string             `json:"error,omitempty"`
}

type RenamedFile struct {
	Original string `json:"original"`
	Final    string `json:"final"`
}

type FailedMove struct {
	FileName string `json:"file_name"`
	Error    string `json:"error"`
}

// ConfirmOrganiseResult reports what ConfirmOrganisePlan actually did.
// FolderName/Files/Created are kept so the existing "organise-complete"
// listener (mainscreen.tsx, wired to the older OrganiseFolder flow) keeps
// working unchanged for plan-confirmed moves too.
type ConfirmOrganiseResult struct {
	FolderName string        `json:"folder_name"`
	Files      []string      `json:"files"`
	Created    bool          `json:"created"`
	Moved      []string      `json:"moved"`
	Renamed    []RenamedFile `json:"renamed,omitempty"`
	Failed     []FailedMove  `json:"failed,omitempty"`
	Error      string        `json:"error,omitempty"`
}

type organisePlanResponse struct {
	NeedsClarification bool   `json:"needs_clarification"`
	TargetFolder       string `json:"target_folder"`
	Moves              []struct {
		FileName   string `json:"file_name"`
		FolderPath string `json:"folder_path"`
		Reason     string `json:"reason"`
	} `json:"moves"`
	ProposedGroupings []struct {
		FolderName  string `json:"folder_name"`
		Description string `json:"description"`
	} `json:"proposed_groupings"`
	Error string `json:"error,omitempty"`
}

// registerPlan stores a new pending plan and notifies the frontend. Shared
// by ProposeOrganise and chat's propose_reorganisation tool handling, so
// both entry points end up with exactly one plan-creation code path.
func (s *Service) registerPlan(targetFolder string, moves []PlannedMove) *OrganisePlan {
	now := time.Now()
	plan := &OrganisePlan{
		ID:           newPlanID(),
		TargetFolder: targetFolder,
		Moves:        moves,
		CreatedAt:    now,
		ExpiresAt:    now.Add(planTTL),
	}
	s.organisePlans.create(plan.ID, plan)
	wailsruntime.EventsEmit(s.ctx, "organise-plan-ready", plan)
	return plan
}

// ProposeOrganise asks the sidecar to search→judge→build a reorganisation
// plan for the given instruction. Moves nothing. If the instruction was too
// vague, returns proposed groupings instead of a plan (and emits
// "organise-clarification" so the UI can offer them as buttons).
func (s *Service) ProposeOrganise(message, currentFolder string) (OrganisePreview, error) {
	if s.UserID == "" {
		return OrganisePreview{}, fmt.Errorf("not authenticated")
	}
	if !sidecar.Ready() {
		return OrganisePreview{}, fmt.Errorf("AI organise not available — sidecar not running")
	}

	body, _ := json.Marshal(map[string]string{
		"message":        message,
		"user_id":        s.UserID,
		"current_folder": currentFolder,
	})
	client := &http.Client{Timeout: 45 * time.Second}
	resp, err := client.Post(sidecar.BaseURL+"/search/organise-plan", "application/json", bytes.NewReader(body))
	if err != nil {
		return OrganisePreview{}, fmt.Errorf("organise-plan request failed: %w", err)
	}
	defer resp.Body.Close()

	var out organisePlanResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return OrganisePreview{}, fmt.Errorf("decode organise-plan response: %w", err)
	}

	if out.NeedsClarification {
		groupings := make([]ProposedGrouping, 0, len(out.ProposedGroupings))
		for _, g := range out.ProposedGroupings {
			groupings = append(groupings, ProposedGrouping{FolderName: g.FolderName, Description: g.Description})
		}
		preview := OrganisePreview{NeedsClarification: true, ProposedGroupings: groupings}
		wailsruntime.EventsEmit(s.ctx, "organise-clarification", preview)
		return preview, nil
	}
	if out.Error != "" {
		return OrganisePreview{Error: out.Error}, nil
	}

	moves := make([]PlannedMove, 0, len(out.Moves))
	for _, m := range out.Moves {
		moves = append(moves, PlannedMove{
			FileName:   m.FileName,
			FromFolder: m.FolderPath,
			ToFolder:   out.TargetFolder,
			Reason:     m.Reason,
		})
	}
	plan := s.registerPlan(out.TargetFolder, moves)
	return OrganisePreview{PlanID: plan.ID, TargetFolder: plan.TargetFolder, Moves: plan.Moves}, nil
}

// handleOrganiseProposalFromChat mirrors ProposeOrganise's response
// handling, but for the "organise_proposal" SSE event emitted mid-stream by
// chat's propose_reorganisation tool (decoded generically as
// map[string]interface{}, unlike ProposeOrganise's typed HTTP response).
func (s *Service) handleOrganiseProposalFromChat(event map[string]interface{}) {
	if needsClarification, _ := event["needs_clarification"].(bool); needsClarification {
		wailsruntime.EventsEmit(s.ctx, "organise-clarification", OrganisePreview{
			NeedsClarification: true,
			ProposedGroupings:  decodeProposedGroupings(event["proposed_groupings"]),
		})
		return
	}
	if errMsg, _ := event["error"].(string); errMsg != "" {
		wailsruntime.EventsEmit(s.ctx, "organise-plan-error", errMsg)
		return
	}
	targetFolder, _ := event["target_folder"].(string)
	moves := decodePlannedMoves(event["moves"], targetFolder)
	s.registerPlan(targetFolder, moves)
}

func decodePlannedMoves(raw interface{}, targetFolder string) []PlannedMove {
	list, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	moves := make([]PlannedMove, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		fileName, _ := m["file_name"].(string)
		if fileName == "" {
			continue
		}
		folderPath, _ := m["folder_path"].(string)
		reason, _ := m["reason"].(string)
		moves = append(moves, PlannedMove{
			FileName:   fileName,
			FromFolder: folderPath,
			ToFolder:   targetFolder,
			Reason:     reason,
		})
	}
	return moves
}

func decodeProposedGroupings(raw interface{}) []ProposedGrouping {
	list, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	groupings := make([]ProposedGrouping, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		folderName, _ := m["folder_name"].(string)
		if folderName == "" {
			continue
		}
		description, _ := m["description"].(string)
		groupings = append(groupings, ProposedGrouping{FolderName: folderName, Description: description})
	}
	return groupings
}

// ConfirmOrganisePlan creates the target folder (if needed) and moves only
// the selected files from a previously-proposed plan, through the existing
// vault move path (no re-embedding). Never deletes anything; never moves
// anything that wasn't both planned AND selected.
func (s *Service) ConfirmOrganisePlan(planID string, selectedFileNames []string) (ConfirmOrganiseResult, error) {
	plan, ok := s.organisePlans.get(planID)
	if !ok {
		return ConfirmOrganiseResult{}, fmt.Errorf("plan not found or expired — try organising again")
	}

	selected := make(map[string]bool, len(selectedFileNames))
	for _, f := range selectedFileNames {
		selected[f] = true
	}

	if err := s.Vault.CreateFolder(plan.TargetFolder); err != nil {
		return ConfirmOrganiseResult{}, fmt.Errorf("could not create folder: %w", err)
	}

	result := ConfirmOrganiseResult{FolderName: plan.TargetFolder, Created: true}
	var moves []fileMove

	for _, mv := range plan.Moves {
		if !selected[mv.FileName] {
			continue
		}
		_, curFolder, ferr := s.Vault.FindFileInVault(mv.FileName)
		if ferr != nil {
			result.Failed = append(result.Failed, FailedMove{FileName: mv.FileName, Error: "file no longer found in vault"})
			continue
		}
		if curFolder == plan.TargetFolder {
			continue
		}

		finalName := mv.FileName
		if s.Vault.FileExistsInFolder(mv.FileName, plan.TargetFolder) {
			suggested, cerr := s.Vault.NextAvailableName(mv.FileName, plan.TargetFolder)
			if cerr != nil {
				result.Failed = append(result.Failed, FailedMove{FileName: mv.FileName, Error: "name collision, no free name found"})
				continue
			}
			if err := s.Vault.RenameFile(mv.FileName, suggested); err != nil {
				result.Failed = append(result.Failed, FailedMove{FileName: mv.FileName, Error: err.Error()})
				continue
			}
			finalName = suggested
			result.Renamed = append(result.Renamed, RenamedFile{Original: mv.FileName, Final: suggested})
		}

		if err := s.Vault.MoveFileToFolder(finalName, plan.TargetFolder); err != nil {
			result.Failed = append(result.Failed, FailedMove{FileName: mv.FileName, Error: err.Error()})
			continue
		}
		result.Moved = append(result.Moved, finalName)
		result.Files = append(result.Files, finalName)
		moves = append(moves, fileMove{FileName: finalName, FromFolder: curFolder})
	}

	s.organisePlans.remove(planID)
	if len(moves) > 0 {
		s.lastOrganise = &organiseRecord{TargetFolder: plan.TargetFolder, Moves: moves}
	}

	wailsruntime.EventsEmit(s.ctx, "organise-complete", result)
	fmt.Printf("✅ Confirmed organise: %d moved into %s (%d failed)\n", len(result.Moved), plan.TargetFolder, len(result.Failed))
	return result, nil
}

// CancelOrganisePlan discards a pending plan without moving anything.
func (s *Service) CancelOrganisePlan(planID string) error {
	s.organisePlans.remove(planID)
	return nil
}

// ── Enrichment backfill ──────────────────────────────────────────────────

// BackfillResult reports how many already-indexed files got a new profile.
type BackfillResult struct {
	Enriched int `json:"enriched"`
	Skipped  int `json:"skipped"`
	Failed   int `json:"failed"`
}

// BackfillFileProfiles generates profiles for files that were ingested
// before file-profile enrichment existed (or whose profile generation
// previously failed). Emits "backfill-progress" as it goes and
// "backfill-done" when finished.
func (s *Service) BackfillFileProfiles() (BackfillResult, error) {
	result := BackfillResult{}
	if s.UserID == "" {
		return result, fmt.Errorf("not authenticated")
	}
	if !sidecar.Ready() {
		return result, fmt.Errorf("AI backfill not available — sidecar not running")
	}

	missing, err := s.Vault.Sidecar.GetFilesMissingProfiles()
	if err != nil {
		return result, fmt.Errorf("could not list files missing profiles: %w", err)
	}

	total := len(missing)
	wailsruntime.EventsEmit(s.ctx, "backfill-progress", map[string]int{"done": 0, "total": total})

	for i, name := range missing {
		absPath, _, ferr := s.Vault.FindFileInVault(name)
		if ferr != nil {
			absPath = "" // still try — /ingest/enrich works from indexed chunks alone
		}
		status, eerr := s.Vault.Sidecar.EnrichFile(absPath, name)
		switch {
		case eerr != nil:
			fmt.Printf("⚠️ Backfill failed for %s: %v\n", name, eerr)
			result.Failed++
		case status == "skipped":
			result.Skipped++
		default:
			result.Enriched++
		}
		wailsruntime.EventsEmit(s.ctx, "backfill-progress", map[string]int{"done": i + 1, "total": total})
	}

	wailsruntime.EventsEmit(s.ctx, "backfill-done", result)
	fmt.Printf("✅ Backfill complete: %d enriched, %d skipped, %d failed\n", result.Enriched, result.Skipped, result.Failed)
	return result, nil
}

// ── Rename flow: search wide → propose names → preview → confirm → rename ──

// handleRenameProposalFromChat handles the "rename_proposal" SSE event
// emitted mid-stream by chat's propose_rename tool. Unlike organise
// (which also has a direct-call ProposeOrganise path with an asymmetric
// "check the return value for error" case), rename has no non-chat entry
// point — every outcome, including errors, is always an event here.
func (s *Service) handleRenameProposalFromChat(event map[string]interface{}) {
	if errMsg, _ := event["error"].(string); errMsg != "" {
		wailsruntime.EventsEmit(s.ctx, "rename-plan-error", errMsg)
		return
	}
	renames := s.decodePlannedRenames(event["renames"])
	if len(renames) == 0 {
		wailsruntime.EventsEmit(s.ctx, "rename-plan-error", "no files to rename")
		return
	}
	now := time.Now()
	plan := &RenamePlan{ID: newPlanID(), Renames: renames, CreatedAt: now, ExpiresAt: now.Add(planTTL)}
	s.renamePlans.create(plan.ID, plan)
	wailsruntime.EventsEmit(s.ctx, "rename-plan-ready", plan)
}

// decodePlannedRenames turns the sidecar's raw "renames" array into
// []PlannedRename: sanitizes every proposed name (vault.SanitizeFileName
// — never the raw model output), restores an extension the model omitted
// (not a "change" — just completing an incomplete name), flags a
// genuinely changed one as a non-blocking warning, and resolves
// collisions both within this batch and vault-wide (see
// FileExistsAnywhereInVault's doc comment for why vault-wide, not
// folder-scoped) before the plan is ever shown to the user.
func (s *Service) decodePlannedRenames(raw interface{}) []PlannedRename {
	list, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	usedInBatch := make(map[string]bool)
	var out []PlannedRename
	for _, item := range list {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		fileName, _ := m["file_name"].(string)
		folderPath, _ := m["folder_path"].(string)
		newNameRaw, _ := m["new_name"].(string)
		reason, _ := m["reason"].(string)
		if fileName == "" || newNameRaw == "" {
			continue
		}

		sanitized := vault.SanitizeFileName(newNameRaw)
		origExt := filepath.Ext(fileName)
		sanitizedExt := filepath.Ext(sanitized)
		if sanitizedExt == "" && origExt != "" {
			// Model omitted the extension — restore it. This completes an
			// incomplete name, it isn't "changing" one, so no warning.
			sanitized += origExt
			sanitizedExt = origExt
		}
		extChanged := !strings.EqualFold(sanitizedExt, origExt)

		finalName := s.resolveRenameCollision(sanitized, fileName, usedInBatch)
		if finalName == "" {
			continue // collision resolution exhausted — skip rather than propose an impossible rename
		}

		usedInBatch[strings.ToLower(finalName)] = true
		out = append(out, PlannedRename{
			FileName: fileName, FolderPath: folderPath, OldName: fileName,
			NewName: finalName, Reason: reason, ExtensionChanged: extChanged,
		})
	}
	return out
}

// resolveRenameCollision returns a vault-wide-collision-free name for a
// (sanitized) proposed rename, treating the file's own current name
// (currentName) as never a collision with itself. Shared by
// decodePlannedRenames (building the preview) and ConfirmRenamePlan
// (re-checking at confirm time, since the vault may have changed, or the
// user may have edited the name).
//
// Known, accepted limitation: within one batch, if file A is renamed to
// a name file B currently holds while B is also being renamed away from
// it in the same batch, processing order matters — this mirrors an
// equivalent pre-existing simplification in organise's move-collision
// handling, not a new class of bug.
func (s *Service) resolveRenameCollision(proposed, currentName string, usedInBatch map[string]bool) string {
	finalName := proposed
	for finalName != "" && (usedInBatch[strings.ToLower(finalName)] ||
		(finalName != currentName && s.Vault.FileExistsAnywhereInVault(finalName))) {
		next, err := s.Vault.NextAvailableNameVaultWide(finalName)
		if err != nil {
			return ""
		}
		finalName = next
	}
	return finalName
}

// ConfirmRenamePlan renames only the selected files from a previously
// proposed plan, through the existing vault.RenameFile path (local FS ->
// Supabase -> ChromaDB metadata rewrite, no re-embed). An edited name
// from the frontend is re-sanitized and re-collision-checked here —
// never trusted as-is, same as the model's original proposal.
func (s *Service) ConfirmRenamePlan(planID string, selections []RenameSelection) (ConfirmRenameResult, error) {
	plan, ok := s.renamePlans.get(planID)
	if !ok {
		return ConfirmRenameResult{}, fmt.Errorf("plan not found or expired — try again")
	}

	bySelection := make(map[string]RenameSelection, len(selections))
	for _, sel := range selections {
		bySelection[sel.FileName] = sel
	}

	result := ConfirmRenameResult{}
	usedInBatch := make(map[string]bool)

	for _, planned := range plan.Renames {
		sel, ok := bySelection[planned.FileName]
		if !ok || !sel.Include {
			continue
		}

		proposedNew := planned.NewName
		if sel.EditedNewName != "" {
			proposedNew = vault.SanitizeFileName(sel.EditedNewName)
		}

		if _, _, ferr := s.Vault.FindFileInVault(planned.OldName); ferr != nil {
			result.Failed = append(result.Failed, FailedMove{FileName: planned.OldName, Error: "file no longer found in vault"})
			continue
		}
		if proposedNew == planned.OldName {
			continue // no-op
		}

		finalName := s.resolveRenameCollision(proposedNew, planned.OldName, usedInBatch)
		if finalName == "" {
			result.Failed = append(result.Failed, FailedMove{FileName: planned.OldName, Error: "name collision, no free name found"})
			continue
		}

		if err := s.Vault.RenameFile(planned.OldName, finalName); err != nil {
			result.Failed = append(result.Failed, FailedMove{FileName: planned.OldName, Error: err.Error()})
			continue
		}
		usedInBatch[strings.ToLower(finalName)] = true
		result.Renamed = append(result.Renamed, RenameResultItem{Original: planned.OldName, Final: finalName})
	}

	s.renamePlans.remove(planID)
	wailsruntime.EventsEmit(s.ctx, "rename-complete", result)
	fmt.Printf("✅ Confirmed rename: %d renamed (%d failed)\n", len(result.Renamed), len(result.Failed))
	return result, nil
}

// CancelRenamePlan discards a pending plan without renaming anything.
func (s *Service) CancelRenamePlan(planID string) error {
	s.renamePlans.remove(planID)
	return nil
}
