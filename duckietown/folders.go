package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// FolderRecord represents a folder in the vault hierarchy.
type FolderRecord struct {
	Path     string `json:"path"`     // relative from vault root e.g. "work/invoices"
	Name     string `json:"name"`     // just the last segment e.g. "invoices"
	Parent   string `json:"parent"`   // parent path e.g. "work", "" for root-level
	Children int    `json:"children"` // number of direct subfolders
}

// ListFolders returns all folders under the vault as a flat list sorted by path.
// Exposed to frontend via Wails.
func (a *App) ListFolders() ([]FolderRecord, error) {
	if a.vaultPath == "" {
		return nil, nil
	}
	var folders []FolderRecord
	err := filepath.WalkDir(a.vaultPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if path == a.vaultPath {
			return nil // skip vault root itself
		}
		name := d.Name()
		// Skip hidden dirs
		if strings.HasPrefix(name, ".") {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(a.vaultPath, path)
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

	// Count direct children for each folder
	childCount := make(map[string]int)
	for _, f := range folders {
		if f.Parent != "" {
			childCount[f.Parent]++
		}
	}
	for i := range folders {
		folders[i].Children = childCount[folders[i].Path]
	}

	sort.Slice(folders, func(i, j int) bool {
		return folders[i].Path < folders[j].Path
	})
	return folders, nil
}

// CreateFolder creates a new folder at the given relative path under the vault.
// Exposed to frontend via Wails.
func (a *App) CreateFolder(relativePath string) error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path set")
	}
	// Sanitise
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	if relativePath == "." || relativePath == "" {
		return fmt.Errorf("invalid folder path")
	}
	absPath := filepath.Join(a.vaultPath, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(absPath, 0755); err != nil {
		return fmt.Errorf("could not create folder: %w", err)
	}
	// Add to watcher so new files inside are picked up immediately
	a.watchDir(absPath)
	wailsruntime.EventsEmit(a.ctx, "folder-created", relativePath)
	fmt.Printf("📁 Created folder: %s\n", relativePath)
	return nil
}

// DeleteFolder deletes a folder and all its contents locally and from Supabase.
// Exposed to frontend via Wails.
func (a *App) DeleteFolder(relativePath string) error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path set")
	}
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	absPath := filepath.Join(a.vaultPath, filepath.FromSlash(relativePath))

	// Collect all files inside before deletion so we can clean Supabase
	var filePaths []struct{ abs, name, folder string }
	filepath.WalkDir(absPath, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if shouldSkipFile(name) {
			return nil
		}
		rel, _ := filepath.Rel(a.vaultPath, p)
		rel = filepath.ToSlash(rel)
		folder := filepath.ToSlash(filepath.Dir(rel))
		if folder == "." {
			folder = ""
		}
		filePaths = append(filePaths, struct{ abs, name, folder string }{p, name, folder})
		return nil
	})

	// Delete local folder tree
	if err := os.RemoveAll(absPath); err != nil {
		return fmt.Errorf("could not delete folder: %w", err)
	}

	// Clean up Supabase and ChromaDB for each file
	for _, f := range filePaths {
		a.supaDeleteStorageFile(f.name, f.folder)
		a.supaDeleteFileRecord(f.name)
		go a.DeleteFileEmbeddings(f.name)
	}

	wailsruntime.EventsEmit(a.ctx, "folder-deleted", relativePath)
	fmt.Printf("🗑 Deleted folder: %s\n", relativePath)
	return nil
}

// MoveFileToFolder moves a file from its current location to a new folder path.
// Updates local filesystem, Supabase storage + DB, and ChromaDB metadata.
// Exposed to frontend via Wails.
func (a *App) MoveFileToFolder(fileName, targetFolderPath string) error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path set")
	}

	// Find current file location by scanning vault
	currentPath, currentFolder, err := a.findFileInVault(fileName)
	if err != nil {
		return fmt.Errorf("file not found in vault: %w", err)
	}
	if currentFolder == targetFolderPath {
		return nil // already there
	}

	// Build destination path
	var destDir string
	if targetFolderPath == "" {
		destDir = a.vaultPath
	} else {
		destDir = filepath.Join(a.vaultPath, filepath.FromSlash(targetFolderPath))
	}
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("could not create destination: %w", err)
	}
	destPath := filepath.Join(destDir, fileName)

	// Move locally
	if err := os.Rename(currentPath, destPath); err != nil {
		return fmt.Errorf("could not move file: %w", err)
	}

	// Update Supabase storage — upload to new path, delete old
	newSP := a.storagePath(fileName, targetFolderPath)
	a.supaUploadFile(destPath, fileName, targetFolderPath)
	a.supaDeleteStorageFile(fileName, currentFolder)
	a.supaUpdateFileFolderPath(fileName, targetFolderPath, newSP)

	// Update ChromaDB metadata only — no re-embedding
	go a.MoveFileEmbeddings(fileName, fileName)

	wailsruntime.EventsEmit(a.ctx, "file-moved", map[string]string{
		"file_name":   fileName,
		"from_folder": currentFolder,
		"to_folder":   targetFolderPath,
	})
	return nil
}

// findFileInVault searches the vault for a file by name and returns its abs path and folder path.
func (a *App) findFileInVault(fileName string) (absPath, folderPath string, err error) {
	err = filepath.WalkDir(a.vaultPath, func(p string, d os.DirEntry, e error) error {
		if e != nil || d.IsDir() {
			return nil
		}
		if d.Name() == fileName {
			absPath = p
			rel, _ := filepath.Rel(a.vaultPath, filepath.Dir(p))
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

// folderPathForFile returns the folder_path for a given absolute file path.
func (a *App) folderPathForFile(absFilePath string) string {
	dir := filepath.Dir(absFilePath)
	rel, err := filepath.Rel(a.vaultPath, dir)
	if err != nil {
		return ""
	}
	rel = filepath.ToSlash(rel)
	if rel == "." {
		return ""
	}
	return rel
}
