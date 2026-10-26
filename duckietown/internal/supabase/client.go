// Package supabase wraps every direct HTTP call to a Supabase project:
// Postgres REST (files table), Storage (blobs), and GoTrue (auth).
package supabase

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"time"
)

const bucket = "duckietown"

var httpClient = func() *http.Client {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if ok {
		cloned := transport.Clone()
		// Force HTTP/1.1. Avoids rare "http2: response body closed" issues
		// observed when decoding Supabase responses.
		cloned.ForceAttemptHTTP2 = false
		if cloned.TLSClientConfig == nil {
			cloned.TLSClientConfig = &tls.Config{}
		}
		cloned.TLSClientConfig.NextProtos = []string{"http/1.1"}
		return &http.Client{Timeout: 10 * time.Second, Transport: cloned}
	}
	return &http.Client{Timeout: 10 * time.Second}
}()

// Client holds one Supabase project's credentials plus the signed-in user's
// tokens. It is shared (by pointer) across the vault, agent, and authsvc
// packages, so that updating AccessToken in one place (a token refresh)
// is immediately visible everywhere else.
type Client struct {
	URL, Key    string
	UserID      string
	AccessToken string

	// OnUnauthorized is invoked when a request comes back 401. It should
	// refresh the session, update Client.AccessToken itself (the client is
	// shared by pointer), and report whether the retry should proceed.
	// Wired by the composition root to authsvc.Service.RefreshAndSync.
	OnUnauthorized func() bool
}

func NewClient(url, key string) *Client {
	return &Client{URL: url, Key: key}
}

// SetUser updates the signed-in identity. Called by the composition root
// whenever auth state changes (login, session restore, refresh, sign-out).
func (c *Client) SetUser(userID, accessToken string) {
	c.UserID = userID
	c.AccessToken = accessToken
}

func (c *Client) headers(req *http.Request) {
	req.Header.Set("apikey", c.Key)
	if req.Header.Get("Authorization") != "" {
		return
	}
	if c.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.AccessToken)
		return
	}
	req.Header.Set("Authorization", "Bearer "+c.Key)
}

// Do sends a request with Supabase auth headers attached, and on a 401
// triggers OnUnauthorized (token refresh) and retries once.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	c.headers(req)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode == http.StatusUnauthorized && c.OnUnauthorized != nil {
		resp.Body.Close()

		if ok := c.OnUnauthorized(); ok {
			newReq, err := http.NewRequest(req.Method, req.URL.String(), req.Body)
			if err != nil {
				return nil, err
			}
			for key, values := range req.Header {
				for _, value := range values {
					newReq.Header.Add(key, value)
				}
			}
			c.headers(newReq)
			return httpClient.Do(newReq)
		}
	}

	return resp, nil
}

// StoragePath returns {user_id}/{folder_path}/{filename}. folderPath is ""
// for root files.
func (c *Client) StoragePath(fileName, folderPath string) string {
	if folderPath == "" {
		return fmt.Sprintf("%s/%s", c.UserID, fileName)
	}
	return fmt.Sprintf("%s/%s/%s", c.UserID, folderPath, fileName)
}
