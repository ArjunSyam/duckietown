package vault

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// FileRoutePrefix is the path prefix the frontend requests local vault
// files under, e.g. `<img src="/vaultfile/photos/cat.png">`. Serving
// straight from disk — rather than always round-tripping to Supabase for
// a signed Storage URL — means thumbnails for files already synced
// locally (the common case) cost zero network calls and zero IPC: the
// webview's own `<img>` tag loads it exactly like a static asset.
const FileRoutePrefix = "/vaultfile/"

// FileHandler serves files from within the vault directory, rejecting
// anything that resolves outside it. Supports Range and conditional GET
// (via http.ServeContent, keyed off each file's mtime) for free, so a
// browser that already has a thumbnail cached won't re-read it from disk.
func (s *Service) FileHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Path == "" {
			http.NotFound(w, r)
			return
		}

		rel := strings.TrimPrefix(r.URL.Path, FileRoutePrefix)
		if rel == "" {
			http.NotFound(w, r)
			return
		}

		absVault, err := filepath.Abs(s.Path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		resolved := filepath.Join(absVault, filepath.FromSlash(rel))

		// Path traversal guard: resolved must stay within the vault dir.
		if resolved != absVault && !strings.HasPrefix(resolved, absVault+string(os.PathSeparator)) {
			http.NotFound(w, r)
			return
		}

		info, err := os.Stat(resolved)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}

		f, err := os.Open(resolved)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()

		w.Header().Set("Cache-Control", "private, max-age=3600")
		http.ServeContent(w, r, filepath.Base(resolved), info.ModTime(), f)
	})
}
