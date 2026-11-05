//go:build !windows

// Package shell applies Windows-only Explorer integration for the vault
// folder. On every other OS it's a no-op with the same exported
// signatures, so callers never need OS-conditional code.
package shell

// EnsureIcon is a no-op outside Windows.
func EnsureIcon() (string, error) { return "", nil }

// RegisterVaultFolder is a no-op outside Windows.
func RegisterVaultFolder(vaultPath string) error { return nil }

// MoveVaultFolder is a no-op outside Windows.
func MoveVaultFolder(oldPath, newPath string) error { return nil }

// Remove is a no-op outside Windows.
func Remove(vaultPath string) error { return nil }
