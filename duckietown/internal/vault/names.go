package vault

import (
	"path/filepath"
	"regexp"
	"strings"
)

// invalidFileNameChars matches every character Windows forbids directly
// in a file name — the nine reserved punctuation characters plus the
// full ASCII control range.
var invalidFileNameChars = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1F]`)

var reservedDeviceNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// maxSanitizedNameLen caps the name BEFORE any " (2)".." (999)" collision
// suffix is appended later, leaving headroom under Windows' path limits.
const maxSanitizedNameLen = 120

// SanitizeFileName cleans a proposed file name — a model's raw rename
// suggestion, or a user's inline-edited name — into something safe to
// put on an NTFS/Windows filesystem. NEVER trust a raw proposed name from
// any external source: call this on every one before it reaches any
// filesystem call.
//
// It does NOT special-case the extension — callers that care whether the
// extension changed (or was dropped) compare filepath.Ext(old) vs
// filepath.Ext(result) themselves (see agent.go's decodePlannedRenames),
// since only the caller knows whether an extension change was requested.
func SanitizeFileName(proposed string) string {
	name := invalidFileNameChars.ReplaceAllString(proposed, "_")
	name = strings.TrimRight(name, " .")
	if name == "" {
		name = "untitled"
	}

	// Extension is extracted BEFORE length-capping so a long name doesn't
	// lose it to truncation.
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	if base == "" {
		base = "untitled"
	}

	maxBaseLen := maxSanitizedNameLen - len(ext)
	if maxBaseLen < 1 {
		maxBaseLen = 1
	}
	if len(base) > maxBaseLen {
		base = strings.TrimRight(base[:maxBaseLen], " .")
		if base == "" {
			base = "untitled"
		}
	}

	if reservedDeviceNames[strings.ToUpper(base)] {
		base += "_"
	}
	return base + ext
}
