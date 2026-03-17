package main

import (
	"mime"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
)

// openPath opens any file or folder with the system default application
func openPath(path string) error {
	switch goruntime.GOOS {
	case "windows":
		return exec.Command("cmd", "/c", "start", "", path).Start()
	case "darwin":
		return exec.Command("open", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}

// getMimeType returns the correct MIME type for a filename
func getMimeType(fileName string) string {
	mime.AddExtensionType(".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	mime.AddExtensionType(".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	mime.AddExtensionType(".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")
	mime.AddExtensionType(".doc", "application/msword")
	mime.AddExtensionType(".xls", "application/vnd.ms-excel")
	mime.AddExtensionType(".ppt", "application/vnd.ms-powerpoint")
	mime.AddExtensionType(".md", "text/markdown")
	mime.AddExtensionType(".csv", "text/csv")

	mimeType := mime.TypeByExtension(filepath.Ext(fileName))
	if mimeType == "" {
		return "application/octet-stream"
	}
	return mimeType
}
