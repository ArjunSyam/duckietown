package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Fixed port for OAuth callback.
// Must be in Supabase → Authentication → URL Configuration → Redirect URLs
const callbackPort = 49155
const callbackURL = "http://localhost:49155/callback"

// ── Auth types ─────────────────────────────────────────

type AuthUser struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// ── Sign in with Google ────────────────────────────────

func (a *App) SignInWithGoogle() error {
	serverReady := make(chan struct{})

	go a.listenForCallback(serverReady)

	// Block until the port is genuinely bound and listening
	select {
	case <-serverReady:
	case <-time.After(5 * time.Second):
		return fmt.Errorf("callback server failed to start on port %d", callbackPort)
	}

	// Build Supabase Google OAuth URL
	oauthURL := fmt.Sprintf(
		"%s/auth/v1/authorize?provider=google&redirect_to=%s",
		a.supaURL,
		callbackURL,
	)

	// Open in system browser
	if err := openPath(oauthURL); err != nil {
		return fmt.Errorf("could not open browser: %w", err)
	}

	return nil
}

// listenForCallback binds the port first, signals ready, then serves
func (a *App) listenForCallback(ready chan struct{}) {
	// Bind the port immediately — OS reserves it right here
	// This is guaranteed to be listening before we close(ready)
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", callbackPort))
	if err != nil {
		close(ready)
		wailsruntime.EventsEmit(a.ctx, "auth-error",
			fmt.Sprintf("port %d already in use: %s", callbackPort, err.Error()))
		return
	}

	mux := http.NewServeMux()
	server := &http.Server{Handler: mux}

	// Port is bound — signal ready so browser can open
	close(ready)

	// /callback — Supabase redirects here after Google auth
	// Tokens are in the URL fragment (#access_token=...) so we
	// serve an HTML page that reads the fragment and POSTs it back
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
  <title>Duckietown — Signing in...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1c1c1c;
      color: #d4d4d4;
      font-family: system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }
    .card {
      text-align: center;
      padding: 2rem;
      background: #252526;
      border: 1px solid #3e3e42;
      border-radius: 12px;
      max-width: 320px;
      width: 100%%;
    }
    h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
    p  { font-size: 0.85rem; color: #6a6a6a; }
    .spinner {
      width: 28px; height: 28px;
      border: 2px solid #3e3e42;
      border-top-color: #6366f1;
      border-radius: 50%%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner" id="spinner"></div>
    <h2 id="title">Signing you in...</h2>
    <p id="msg">You can close this tab and return to Duckietown.</p>
  </div>
  <script>
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken  = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (accessToken) {
      fetch('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token:  accessToken,
          refresh_token: refreshToken || ''
        })
      }).then(res => {
        if (res.ok) {
          document.getElementById('spinner').style.display = 'none';
          document.getElementById('title').textContent = 'Signed in!';
          document.getElementById('msg').textContent   = 'Return to Duckietown.';
        } else {
          document.getElementById('title').textContent = 'Something went wrong';
          document.getElementById('msg').textContent   = 'Please try again.';
        }
      });
    } else {
      document.getElementById('title').textContent = 'Authentication failed';
      document.getElementById('msg').textContent   = 'No token received. Please try again.';
    }
  </script>
</body>
</html>`)
	})

	// /token — receives the token POSTed from the HTML page
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		var tokens struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
		}
		if err := json.Unmarshal(body, &tokens); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		if tokens.AccessToken == "" {
			wailsruntime.EventsEmit(a.ctx, "auth-error", "no access token received")
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		// Fetch user info from Supabase
		user, err := a.supaGetUser(tokens.AccessToken)
		if err != nil {
			wailsruntime.EventsEmit(a.ctx, "auth-error", err.Error())
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		// Store session in memory
		a.accessToken = tokens.AccessToken
		a.userID = user.ID
		a.email = user.Email

		// Persist to disk
		saveSession(Session{
			AccessToken:  tokens.AccessToken,
			RefreshToken: tokens.RefreshToken,
			UserID:       user.ID,
			Email:        user.Email,
		})

		// Tell frontend auth succeeded
		wailsruntime.EventsEmit(a.ctx, "auth-success", map[string]string{
			"user_id": user.ID,
			"email":   user.Email,
		})

		w.WriteHeader(http.StatusOK)

		// Shut down server cleanly after response is sent
		go func() {
			time.Sleep(500 * time.Millisecond)
			server.Shutdown(context.Background())
		}()
	})

	// Serve on the already-bound listener — no race condition possible
	server.Serve(listener)
}

// supaGetUser fetches user info from Supabase using an access token
func (a *App) supaGetUser(accessToken string) (AuthUser, error) {
	req, _ := http.NewRequest("GET", a.supaURL+"/auth/v1/user", nil)
	req.Header.Set("apikey", a.supaKey)
	req.Header.Set("Authorization", "Bearer "+accessToken)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return AuthUser{}, fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	var user AuthUser
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return AuthUser{}, fmt.Errorf("parse error: %w", err)
	}
	if user.ID == "" {
		return AuthUser{}, fmt.Errorf("invalid session — please try signing in again")
	}
	return user, nil
}

// GetCurrentUser returns the signed-in user or nil
func (a *App) GetCurrentUser() map[string]string {
	if a.userID == "" {
		return nil
	}
	return map[string]string{
		"user_id": a.userID,
		"email":   a.email,
	}
}

// SignOut revokes the token and clears all local state
func (a *App) SignOut() {
	if a.accessToken != "" {
		req, _ := http.NewRequest("POST", a.supaURL+"/auth/v1/logout", strings.NewReader("{}"))
		req.Header.Set("apikey", a.supaKey)
		req.Header.Set("Authorization", "Bearer "+a.accessToken)
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 5 * time.Second}
		client.Do(req)
	}

	a.accessToken = ""
	a.userID = ""
	a.email = ""
	a.vaultPath = ""
	a.isWatching = false

	if a.watcherStop != nil {
		close(a.watcherStop)
		a.watcherStop = nil
	}

	clearSession()
}
