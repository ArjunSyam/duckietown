package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type FolderRecord struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Parent   string `json:"parent"`
	Children int    `json:"children"`
}

func (s *Service) ListFolders() ([]FolderRecord, error) {
	if s.Path == "" {
		return nil, nil
	}
	var folders []FolderRecord
	err := filepath.WalkDir(s.Path, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() || path == s.Path {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(s.Path, path)
		rel = filepath.ToSlash(rel)
		parent := filepath.ToSlash(filepath.Dir(rel))
		if parent == "." {
			parent = ""
		}
		folders = append(folders, FolderRecord{
			Path:   rel,
			Name:   name,
			Parent: parent,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}

	childCount := make(map[string]int)
	for _, f := range folders {
		if f.Parent != "" {
			childCount[f.Parent]++
		}
	}
	for i := range folders {
		folders[i].Children = childCount[folders[i].Path]
	}
	sort.Slice(folders, func(i, j int) bool { return folders[i].Path < folders[j].Path })
	return folders, nil
}

// SanitizeRelativeFolderPath validates a vault-relative folder path coming
// from anywhere a user, the AI organise flow, or another process could
// influence it: rejects absolute paths and any ".." segment. Pass
// allowRoot=true to let "" (and ".") through meaning "the vault root"
// (MoveFileToFolder wants that; CreateFolder never does — you can't create
// "the root").
func SanitizeRelativeFolderPath(p string, allowRoot bool) (string, error) {
	if p == "" {
		if allowRoot {
			return "", nil
		}
		return "", fmt.Errorf("empty folder path")
	}
	if filepath.IsAbs(p) {
		return "", fmt.Errorf("absolute paths are not allowed: %q", p)
	}
	cleaned := filepath.ToSlash(filepath.Clean(p))
	if cleaned == "." {
		if allowRoot {
			return "", nil
		}
		return "", fmt.Errorf("invalid folder path: %q", p)
	}
	for _, seg := range strings.Split(cleaned, "/") {
		if seg == ".." || seg == "" {
			return "", fmt.Errorf("folder path escapes the vault root: %q", p)
		}
	}
	return cleaned, nil
}

// isWithinVault is a defense-in-depth double-check on the final absolute
// path, in addition to SanitizeRelativeFolderPath's segment check.
func isWithinVault(vaultRoot, target string) bool {
	rel, err := filepath.Rel(vaultRoot, target)
	if err != nil {
		return false
	}
	rel = filepath.ToSlash(rel)
	return rel != ".." && !strings.HasPrefix(rel, "../")
}

func (s *Service) CreateFolder(relativePath string) error {
	if s.Path == "" {
		return fmt.Errorf("no vault path set")
	}
	clean, err := SanitizeRelativeFolderPath(relativePath, false)
	if err != nil {
		return err
	}
	absPath := filepath.Join(s.Path, filepath.FromSlash(clean))
	if !isWithinVault(s.Path, absPath) {
		return fmt.Errorf("folder path escapes the vault root: %q", relativePath)
	}
	if err := os.MkdirAll(absPath, 0755); err != nil {
		return fmt.Errorf("could not create folder: %w", err)
	}
	wailsruntime.EventsEmit(s.ctx, "folder-created", clean)
	fmt.Printf("📁 Created folder: %s\n", clean)
	return nil
}

func (s *Service) DeleteFolder(relativePath string) error {
	if s.Path == "" {
		return fmt.Errorf("no vault path set")
	}
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	absPath := filepath.Join(s.Path, filepath.FromSlash(relativePath))

	// Collect all files before deletion
	var filePaths []struct{ abs, name, folder string }
	filepath.WalkDir(absPath, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if shouldSkipFile(name) {
			return nil
		}
		rel, _ := filepath.Rel(s.Path, p)
		rel = filepath.ToSlash(rel)
		folder := filepath.ToSlash(filepath.Dir(rel))
		if folder == "." {
			folder = ""
		}
		filePaths = append(filePaths, struct{ abs, name, folder string }{p, name, folder})
		return nil
	})

	if err := os.RemoveAll(absPath); err != nil {
		return fmt.Errorf("could not delete folder: %w", err)
	}

	// Clean Supabase and ChromaDB for each file
	for _, f := range filePaths {
		s.Supa.DeleteStorageFile(f.name, f.folder)
		s.Supa.DeleteFileRecord(f.name)
		go s.Sidecar.DeleteFileEmbeddings(f.name) // always clean up embeddings
	}

	wailsruntime.EventsEmit(s.ctx, "folder-deleted", relativePath)
	fmt.Printf("🗑 Deleted folder: %s\n", relativePath)
	return nil
}

func (s *Service) MoveFileToFolder(fileName, targetFolderPath string) error {
	if s.Path == "" {
		return fmt.Errorf("no vault path set")
	}
	targetFolderPath, err := SanitizeRelativeFolderPath(targetFolderPath, true)
	if err != nil {
		return err
	}

	currentPath, currentFolder, err := s.FindFileInVault(fileName)
	if err != nil {
		return fmt.Errorf("file not found in vault: %w", err)
	}
	if currentFolder == targetFolderPath {
		return nil
	}

	var destDir string
	if targetFolderPath == "" {
		destDir = s.Path
	} else {
		destDir = filepath.Join(s.Path, filepath.FromSlash(targetFolderPath))
	}
	if !isWithinVault(s.Path, destDir) {
		return fmt.Errorf("folder path escapes the vault root: %q", targetFolderPath)
	}
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("could not create destination: %w", err)
	}
	destPath := filepath.Join(destDir, fileName)

	// Mark as moved BEFORE the filesystem rename so the watcher's Create
	// event suppresses re-ingest when it fires
	markMoved(fileName)

	if err := os.Rename(currentPath, destPath); err != nil {
		return fmt.Errorf("could not move file: %w", err)
	}

	newSP := s.Supa.StoragePath(fileName, targetFolderPath)
	go func() {
		s.Supa.UploadFile(destPath, fileName, targetFolderPath)
		s.Supa.DeleteStorageFile(fileName, currentFolder)
		s.Supa.UpdateFileFolderPath(fileName, targetFolderPath, newSP)
		// Update ChromaDB metadata only — NO re-embedding
		s.Sidecar.MoveFileEmbeddings(fileName, fileName, targetFolderPath)
	}()

	wailsruntime.EventsEmit(s.ctx, "file-moved", map[string]string{
		"file_name":   fileName,
		"from_folder": currentFolder,
		"to_folder":   targetFolderPath,
	})
	// Emit file-uploaded to dismiss any lingering syncing toast
	wailsruntime.EventsEmit(s.ctx, "file-uploaded", fileName)
	return nil
}

func (s *Service) FindFileInVault(fileName string) (absPath, folderPath string, err error) {
	// desktop.ini (internal/shell's folder-icon marker) should never be
	// resolvable through normal file operations, even though shouldSkipFile
	// already keeps it out of the index entirely — defense in depth, since
	// this also protects MoveFileToFolder/RenameFile, which both start here.
	if strings.EqualFold(fileName, "desktop.ini") {
		return "", "", fmt.Errorf("not found")
	}
	err = filepath.WalkDir(s.Path, func(p string, d os.DirEntry, e error) error {
		if e != nil || d.IsDir() {
			return nil
		}
		if d.Name() == fileName {
			absPath = p
			rel, _ := filepath.Rel(s.Path, filepath.Dir(p))
			rel = filepath.ToSlash(rel)
			if rel == "." {
				rel = ""
			}
			folderPath = rel
			return filepath.SkipAll
		}
		return nil
	})
	if absPath == "" && err == nil {
		err = fmt.Errorf("not found")
	}
	return
}

func (s *Service) folderPathForFile(absFilePath string) string {
	dir := filepath.Dir(absFilePath)
	rel, err := filepath.Rel(s.Path, dir)
	if err != nil {
		return ""
	}
	rel = filepath.ToSlash(rel)
	if rel == "." {
		return ""
	}
	return rel
}

// ── Scan-by-type (used by the organize flow) ────────────────────────────

var imageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".webp": true, ".bmp": true, ".svg": true, ".heic": true, ".tiff": true,
}
var audioExts = map[string]bool{
	".mp3": true, ".wav": true, ".aac": true, ".flac": true,
	".ogg": true, ".m4a": true, ".wma": true,
}
var videoExts = map[string]bool{
	".mp4": true, ".mov": true, ".avi": true, ".mkv": true,
	".webm": true, ".wmv": true, ".m4v": true,
}
var textExts = map[string]bool{
	".pdf": true, ".doc": true, ".docx": true, ".txt": true,
	".md": true, ".xlsx": true, ".xls": true, ".csv": true,
	".pptx": true, ".ppt": true, ".rtf": true,
}

// FindFilesByType scans the entire vault and returns filenames matching a modality.
func (s *Service) FindFilesByType(typeFilter string) []string {
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
	filepath.WalkDir(s.Path, func(path string, d os.DirEntry, err error) error {
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

// ── Collision handling (used by the organise confirm flow) ─────────────

// FileExistsInFolder reports whether a file with this exact name already
// sits directly inside the given vault-relative folder. Not a recursive
// vault-wide check — this is specifically for move-collision detection at
// one destination.
func (s *Service) FileExistsInFolder(fileName, folderPath string) bool {
	if s.Path == "" {
		return false
	}
	dir := s.Path
	if folderPath != "" {
		dir = filepath.Join(s.Path, filepath.FromSlash(folderPath))
	}
	_, err := os.Stat(filepath.Join(dir, fileName))
	return err == nil
}

// NextAvailableName returns a collision-free name for targetFolderPath by
// suffixing " (2)", " (3)", ... before the extension.
func (s *Service) NextAvailableName(fileName, targetFolderPath string) (string, error) {
	ext := filepath.Ext(fileName)
	base := strings.TrimSuffix(fileName, ext)
	for i := 2; i <= 999; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if !s.FileExistsInFolder(candidate, targetFolderPath) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not find a free name for %q in %q", fileName, targetFolderPath)
}

// FileExistsAnywhereInVault reports whether a file with this exact name
// exists ANYWHERE in the vault (any folder) — unlike the folder-scoped
// FileExistsInFolder. Required for rename: Supabase's files table
// enforces UNIQUE(user_id, name) vault-wide, not per-folder (see
// docs/ARCHITECTURE.md's database schema section), so a same-folder-only
// collision check could let a rename look collision-free locally while
// silently desyncing Supabase.
func (s *Service) FileExistsAnywhereInVault(fileName string) bool {
	_, _, err := s.FindFileInVault(fileName)
	return err == nil
}

// NextAvailableNameVaultWide is NextAvailableName's vault-wide
// counterpart, for the same reason FileExistsAnywhereInVault exists
// alongside FileExistsInFolder.
func (s *Service) NextAvailableNameVaultWide(fileName string) (string, error) {
	ext := filepath.Ext(fileName)
	base := strings.TrimSuffix(fileName, ext)
	for i := 2; i <= 999; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if !s.FileExistsAnywhereInVault(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not find a free name for %q anywhere in the vault", fileName)
}
