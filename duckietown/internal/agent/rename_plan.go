package agent

import "time"

// PlannedRename is one file's proposed rename within a RenamePlan.
// NewName has already been through vault.SanitizeFileName and collision
// resolution — never the model's raw output — by the time it's stored
// here.
type PlannedRename struct {
	FileName   string `json:"file_name"`   // current name — used to re-resolve the file at confirm time
	FolderPath string `json:"folder_path"` // current folder, display only
	OldName    string `json:"old_name"`
	NewName    string `json:"new_name"`
	Reason     string `json:"reason"`
	// ExtensionChanged is a non-blocking preview warning — never
	// auto-corrected, since Go can't tell "model mistake" from "user
	// explicitly asked to change it" at this layer.
	ExtensionChanged bool `json:"extension_changed,omitempty"`
}

// RenamePlan is a pending rename preview — nothing has renamed yet.
type RenamePlan struct {
	ID        string          `json:"id"`
	Renames   []PlannedRename `json:"renames"`
	CreatedAt time.Time       `json:"created_at"`
	ExpiresAt time.Time       `json:"expires_at"`
}

// RenameSelection is one row's final user decision at confirm time:
// whether to include it, and — if the user edited the proposed name
// inline — the name to use instead of the plan's proposed NewName.
type RenameSelection struct {
	FileName      string `json:"file_name"` // matches PlannedRename.FileName
	Include       bool   `json:"include"`
	EditedNewName string `json:"edited_new_name,omitempty"` // "" = use the plan's new_name unchanged
}

// RenameResultItem reports one successfully renamed file. Final may
// differ from what the user typed/the plan proposed — sanitization and
// collision suffixing happen again at confirm time.
type RenameResultItem struct {
	Original string `json:"original"`
	Final    string `json:"final"`
}

// ConfirmRenameResult reports what ConfirmRenamePlan actually did.
type ConfirmRenameResult struct {
	Renamed []RenameResultItem `json:"renamed"`
	Failed  []FailedMove       `json:"failed,omitempty"` // reuses organise's FailedMove{FileName,Error} shape
	Error   string             `json:"error,omitempty"`
}
