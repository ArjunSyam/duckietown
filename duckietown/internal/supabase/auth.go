package supabase

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// AuthUser is the subset of Supabase's /auth/v1/user response this app uses.
type AuthUser struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type refreshResponse struct {
	AccessToken  string   `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	User         AuthUser `json:"user"`
}

// GetUser fetches user info from Supabase using an access token.
func (c *Client) GetUser(accessToken string) (AuthUser, error) {
	req, _ := http.NewRequest("GET", c.URL+"/auth/v1/user", nil)
	req.Header.Set("apikey", c.Key)
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := c.Do(req)
	if err != nil {
		return AuthUser{}, fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return AuthUser{}, fmt.Errorf("supabase /auth/v1/user failed: %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var user AuthUser
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return AuthUser{}, fmt.Errorf("parse error: %w", err)
	}
	if user.ID == "" {
		return AuthUser{}, fmt.Errorf("invalid session — please try signing in again")
	}
	return user, nil
}

// RefreshToken exchanges a refresh token for a new access/refresh token pair.
func (c *Client) RefreshToken(refreshToken string) (accessToken, newRefreshToken string, err error) {
	if refreshToken == "" {
		return "", "", fmt.Errorf("no refresh token available")
	}

	url := fmt.Sprintf("%s/auth/v1/token?grant_type=refresh_token", c.URL)
	payload, _ := json.Marshal(map[string]string{"refresh_token": refreshToken})

	req, _ := http.NewRequest("POST", url, strings.NewReader(string(payload)))
	req.Header.Set("apikey", c.Key)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("failed to refresh token: %d", resp.StatusCode)
	}

	var res refreshResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", "", err
	}
	return res.AccessToken, res.RefreshToken, nil
}

// Logout revokes the access token with Supabase. Best-effort — errors are ignored,
// matching the original behavior (the local session is cleared regardless).
func (c *Client) Logout(accessToken string) {
	if accessToken == "" {
		return
	}
	req, _ := http.NewRequest("POST", c.URL+"/auth/v1/logout", strings.NewReader("{}"))
	req.Header.Set("apikey", c.Key)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	client.Do(req)
}
