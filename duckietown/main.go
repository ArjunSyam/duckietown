package main

import (
	"embed"
	"net/http"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"duckietown/internal/vault"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	// Serves local vault files directly (see vault.FileHandler) so the
	// frontend can point <img> tags straight at them for thumbnails —
	// no Supabase round-trip, no IPC — falling through to the embedded
	// frontend assets for everything else.
	vaultFiles := app.vaultSvc.FileHandler()
	serveVaultFiles := assetserver.Middleware(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, vault.FileRoutePrefix) {
				vaultFiles.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	})

	err := wails.Run(&options.App{
		Title:            "Duckietown",
		Width:            1100,
		Height:           720,
		MinWidth:         800,
		MinHeight:        550,
		DisableResize:    false,
		Fullscreen:       false,
		WindowStartState: options.Normal,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: serveVaultFiles,
		},
		BackgroundColour: &options.RGBA{R: 18, G: 18, B: 18, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
			Theme:                windows.Dark,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
