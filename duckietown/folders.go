package main

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

func (a *App) ListFolders() ([]FolderRecord, error) {
	if a.vaultPath == "" {
		return nil, nil
	}
	var folders []FolderRecord
	err := filepath.WalkDir(a.vaultPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() || path == a.vaultPath {
			return nil
		}
		name := d.Name()
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

func (a *App) CreateFolder(relativePath string) error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path set")
	}
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	if relativePath == "." || relativePath == "" {
		return fmt.Errorf("invalid folder path")
	}
	absPath := filepath.Join(a.vaultPath, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(absPath, 0755); err != nil {
		return fmt.Errorf("could not create folder: %w", err)
	}
	wailsruntime.EventsEmit(a.ctx, "folder-created", relativePath)
	fmt.Printf("📁 Created folder: %s\n", relativePath)
	return nil
}

func (a *App) DeleteFolder(relativePath string) error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path set")
	}
	relativePath = filepath.ToSlash(filepath.Clean(relativePath))
	absPath := filepath.Join(a.vaultPath, filepath.FromSlash(relativePath))

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
		rel, _ := filepath.Rel(a.vaultPath, p)
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
		a.supaDeleteStorageFile(f.name, f.folder)
		a.supaDeleteFileRecord(f.name)
		go a.DeleteFileEmbeddings(f.name) // always clean up embeddings
	}

	wailsruntime.EventsEmit(a.ctx, "folder-deleted", relativePath)
	fmt.Printf("🗑 Deleted folder: %s\n", relativePath)
	return nil
}

func (a *App) MoveFileToFolder(fileName, targetFolderPath string) error {
	if a.vaultPath == "" {
		return fmt.Errorf("no vault path set")
	}

	currentPath, currentFolder, err := a.findFileInVault(fileName)
	if err != nil {
		return fmt.Errorf("file not found in vault: %w", err)
	}
	if currentFolder == targetFolderPath {
		return nil
	}

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

	// Mark as moved BEFORE the filesystem rename so the watcher's Create
	// event suppresses re-ingest when it fires
	markMoved(fileName)

	if err := os.Rename(currentPath, destPath); err != nil {
		return fmt.Errorf("could not move file: %w", err)
	}

	newSP := a.storagePath(fileName, targetFolderPath)
	go func() {
		a.supaUploadFile(destPath, fileName, targetFolderPath)
		a.supaDeleteStorageFile(fileName, currentFolder)
		a.supaUpdateFileFolderPath(fileName, targetFolderPath, newSP)
		// Update ChromaDB metadata only — NO re-embedding
		a.MoveFileEmbeddings(fileName, fileName)
	}()

	wailsruntime.EventsEmit(a.ctx, "file-moved", map[string]string{
		"file_name":   fileName,
		"from_folder": currentFolder,
		"to_folder":   targetFolderPath,
	})
	// Emit file-uploaded to dismiss any lingering syncing toast
	wailsruntime.EventsEmit(a.ctx, "file-uploaded", fileName)
	return nil
}

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
