// Package authsvc owns Google OAuth sign-in, session persistence, and
// token refresh. It talks to Supabase only through the shared
// supabase.Client the composition root also hands to vault/agent.
package authsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"duckietown/internal/config"
	"duckietown/internal/supabase"
)

// Candidate ports for the local OAuth callback server, tried in order.
// Deliberately kept below Windows' dynamic/ephemeral port range
// (49152-65535): Hyper-V, WSL2, and Docker's winnat reserve blocks in that
// range that no process is allowed to bind, which surfaces as a bind
// failure that looks like (but isn't) "address already in use". EVERY one
// of these must be registered in Supabase under Authentication → URL
// Configuration → Redirect URLs, as http://<callbackHost>:<port>/callback.
var callbackPorts = []int{47155, 47156, 47157}

// callbackHost is used for BOTH the listener's bind address and the
// redirect_to URL sent to Supabase — never "localhost", which can resolve
// to ::1 ahead of 127.0.0.1 and silently miss an IPv4-only listener,
// surfacing as ERR_CONNECTION_REFUSED after Google auth already succeeded.
const callbackHost = "127.0.0.1"
const signInTimeout = 5 * time.Minute

type Service struct {
	ctx  context.Context
	supa *supabase.Client

	userID       string
	email        string
	accessToken  string
	refreshToken string

	// flowMu guards cancelFlow: SignInWithGoogle can be called again
	// (user retries, or clicks twice) while a previous attempt's callback
	// server is still listening, so each call cancels whatever flow came
	// before it rather than leaking/fighting over the port.
	flowMu     sync.Mutex
	cancelFlow context.CancelFunc

	// OnAuthChange fires after a successful login, session restore, or
	// token refresh, so the composition root can propagate the new
	// userID/accessToken into the vault/sidecar/agent services.
	OnAuthChange func(userID, accessToken string)
	// OnSignOut fires after sign-out, so the composition root can reset
	// the vault/sidecar/agent services' auth state.
	OnSignOut func()
}

func NewService(supa *supabase.Client) *Service {
	return &Service{supa: supa}
}

func (s *Service) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// Startup restores a persisted session, if any, refreshing its token.
// Returns an error if a session existed but could not be refreshed
// (caller should treat this as "signed out").
func (s *Service) Startup() error {
	session := config.LoadSession()
	if session.RefreshToken == "" {
		return nil
	}

	s.refreshToken = session.RefreshToken
	s.userID = session.UserID
	s.email = session.Email

	if err := s.refresh(); err != nil {
		config.ClearSession()
		wailsruntime.EventsEmit(s.ctx, "auth-expired", nil)
		return err
	}

	wailsruntime.EventsEmit(s.ctx, "auth-restored", map[string]string{
		"user_id": s.userID,
		"email":   s.email,
	})
	if s.OnAuthChange != nil {
		s.OnAuthChange(s.userID, s.accessToken)
	}
	return nil
}

// ── Sign in with Google ──────────────────────────────────────────────────

func (s *Service) SignInWithGoogle() error {
	// A previous attempt may still be listening (user clicked twice, or
	// retried after closing the browser) — cancel it so it releases its
	// port instead of fighting this one for it.
	s.flowMu.Lock()
	if s.cancelFlow != nil {
		s.cancelFlow()
	}
	flowCtx, cancel := context.WithCancel(context.Background())
	s.cancelFlow = cancel
	s.flowMu.Unlock()

	listener, port, err := bindCallbackListener()
	if err != nil {
		cancel()
		return err
	}

	callbackURL := fmt.Sprintf("http://%s:%d/callback", callbackHost, port)

	// Info-level: lets a bind/redirect host-or-port mismatch (the exact
	// failure mode that causes ERR_CONNECTION_REFUSED after Google auth
	// already succeeded) be spotted directly from the logs.
	fmt.Printf("ℹ️ auth: callback server listening on %s — redirect_to=%s\n",
		listener.Addr().String(), callbackURL)

	go s.serveCallback(flowCtx, cancel, listener, callbackURL)

	// Build Supabase Google OAuth URL
	oauthURL := fmt.Sprintf(
		"%s/auth/v1/authorize?provider=google&redirect_to=%s",
		s.supa.URL,
		callbackURL,
	)

	// Open in system browser
	if err := config.OpenPath(oauthURL); err != nil {
		cancel() // tears down the listener we just started serving on
		return fmt.Errorf("could not open browser: %w", err)
	}

	return nil
}

// bindCallbackListener tries each candidate port, loopback-only, in order
// and returns the listener for the first one that binds. Binding to
// 127.0.0.1 rather than all interfaces avoids unnecessary firewall prompts
// for what is purely a local redirect target.
func bindCallbackListener() (net.Listener, int, error) {
	var failures []string
	for _, port := range callbackPorts {
		listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", callbackHost, port))
		if err == nil {
			return listener, port, nil
		}
		failures = append(failures, fmt.Sprintf("%d (%s)", port, describeBindError(err)))
	}
	return nil, 0, fmt.Errorf(
		"could not start the local sign-in server — every candidate port failed: %s. "+
			"Windows may have reserved some of these ports for Hyper-V/WSL2/Docker; "+
			"run `netsh interface ipv4 show excludedportrange protocol=tcp` to check, "+
			"or free one of them and try again",
		strings.Join(failures, ", "),
	)
}

// describeBindError classifies a bind failure accurately instead of
// assuming "already in use" for every error.
func describeBindError(err error) string {
	switch {
	case isAddrInUse(err):
		return "address already in use"
	case isAccessForbidden(err):
		return "access forbidden — likely reserved by Windows"
	default:
		return err.Error()
	}
}

// serveCallback runs the local HTTP server that receives the OAuth
// redirect and the token it posts back. It shuts the server down exactly
// once — on success, on error, if ctx is canceled (a newer sign-in attempt
// superseded this one, or the app is shutting down), or after
// signInTimeout with no response — so a later SignInWithGoogle call never
// finds this flow's listener still open.
func (s *Service) serveCallback(ctx context.Context, cancel context.CancelFunc, listener net.Listener, callbackURL string) {
	mux := http.NewServeMux()
	server := &http.Server{Handler: mux}

	var shutdownOnce sync.Once
	shutdown := func() {
		shutdownOnce.Do(func() {
			sctx, cancelShutdown := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancelShutdown()
			server.Shutdown(sctx)
		})
	}

	done := make(chan struct{})
	var finishOnce sync.Once
	finish := func() { finishOnce.Do(func() { close(done) }) }

	// /callback — Supabase redirects here after Google auth.
	// Tokens are in the URL fragment (#access_token=...) so we serve an
	// HTML page that reads the fragment and POSTs it back.
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, callbackHTML)
	})

	// /token — receives the token POSTed from the HTML page
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		defer finish()

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
			wailsruntime.EventsEmit(s.ctx, "auth-error", "no access token received")
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		// Fetch user info from Supabase
		user, err := s.supa.GetUser(tokens.AccessToken)
		if err != nil {
			wailsruntime.EventsEmit(s.ctx, "auth-error", err.Error())
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		// Store session in memory
		s.accessToken = tokens.AccessToken
		s.refreshToken = tokens.RefreshToken
		s.userID = user.ID
		s.email = user.Email

		// Persist to disk
		config.SaveSession(config.Session{
			AccessToken:  tokens.AccessToken,
			RefreshToken: tokens.RefreshToken,
			UserID:       user.ID,
			Email:        user.Email,
		})

		if s.OnAuthChange != nil {
			s.OnAuthChange(s.userID, s.accessToken)
		}

		// Tell frontend auth succeeded
		wailsruntime.EventsEmit(s.ctx, "auth-success", map[string]string{
			"user_id": user.ID,
			"email":   user.Email,
		})

		w.WriteHeader(http.StatusOK)
	})

	go func() {
		select {
		case <-done:
		case <-ctx.Done():
		case <-time.After(signInTimeout):
			wailsruntime.EventsEmit(s.ctx, "auth-error", "sign-in timed out after 5 minutes — please try again")
		}
		shutdown()
		cancel()
	}()

	server.Serve(listener)
}

// GetCurrentUser returns the signed-in user, or nil.
func (s *Service) GetCurrentUser() map[string]string {
	if s.userID == "" {
		return nil
	}
	return map[string]string{
		"user_id": s.userID,
		"email":   s.email,
	}
}

// SignOut revokes the token and clears all local state.
func (s *Service) SignOut() {
	s.supa.Logout(s.accessToken)

	s.accessToken = ""
	s.refreshToken = ""
	s.userID = ""
	s.email = ""

	config.ClearSession()

	if s.OnSignOut != nil {
		s.OnSignOut()
	}
}

// refresh exchanges the current refresh token for a new access/refresh
// token pair and persists the result.
func (s *Service) refresh() error {
	access, refresh, err := s.supa.RefreshToken(s.refreshToken)
	if err != nil {
		return err
	}

	s.accessToken = access
	s.refreshToken = refresh

	config.SaveSession(config.Session{
		AccessToken:  s.accessToken,
		RefreshToken: s.refreshToken,
		UserID:       s.userID,
		Email:        s.email,
	})
	return nil
}

// RefreshAndSync refreshes the token and, on success, propagates the new
// access token to every service that needs it. Wired as
// supabase.Client.OnUnauthorized so a 401 triggers exactly this.
func (s *Service) RefreshAndSync() bool {
	if err := s.refresh(); err != nil {
		return false
	}
	if s.OnAuthChange != nil {
		s.OnAuthChange(s.userID, s.accessToken)
	}
	return true
}

const callbackHTML = `<!DOCTYPE html>
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
      width: 100%;
    }
    h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
    p  { font-size: 0.85rem; color: #6a6a6a; }
    .spinner {
      width: 28px; height: 28px;
      border: 2px solid #3e3e42;
      border-top-color: #6366f1;
      border-radius: 50%;
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
      }).then(async res => {
        if (res.ok) {
          document.getElementById('spinner').style.display = 'none';
          document.getElementById('title').textContent = 'Signed in!';
          document.getElementById('msg').textContent   = 'Return to Duckietown.';
        } else {
          const errorText = await res.text();
          document.getElementById('title').textContent = 'Something went wrong';
          document.getElementById('msg').textContent   = errorText || 'Please try again.';
        }
      }).catch(err => {
        document.getElementById('title').textContent = 'Network error';
        document.getElementById('msg').textContent   = err.message || 'Please check your connection.';
      });
    } else {
      document.getElementById('title').textContent = 'Authentication failed';
      document.getElementById('msg').textContent   = 'No token received. Please try again.';
    }
  </script>
</body>
</html>`
