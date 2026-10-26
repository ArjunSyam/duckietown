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

func (s *Service) CreateFolder(relativePath string) error {
	if s.Path == "" {
		return fmt.Errorf("no vault path set")
	}
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	if relativePath == "." || relativePath == "" {
		return fmt.Errorf("invalid folder path")
	}
	absPath := filepath.Join(s.Path, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(absPath, 0755); err != nil {
		return fmt.Errorf("could not create folder: %w", err)
	}
	wailsruntime.EventsEmit(s.ctx, "folder-created", relativePath)
	fmt.Printf("📁 Created folder: %s\n", relativePath)
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
		s.Sidecar.MoveFileEmbeddings(fileName, fileName)
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
