package agent

import "time"

// PlannedMove is one file's proposed move within an OrganisePlan.
type PlannedMove struct {
	FileName   string `json:"file_name"`
	FromFolder string `json:"from_folder"`
	ToFolder   string `json:"to_folder"`
	Reason     string `json:"reason"`
}

// OrganisePlan is a pending reorganisation preview — nothing has moved yet.
// It lives only in memory (in a planStore[*OrganisePlan]) and expires
// after planTTL so a forgotten preview can't be confirmed hours later
// against a vault that's since changed shape.
type OrganisePlan struct {
	ID           string        `json:"id"`
	TargetFolder string        `json:"target_folder"`
	Moves        []PlannedMove `json:"moves"`
	CreatedAt    time.Time     `json:"created_at"`
	ExpiresAt    time.Time     `json:"expires_at"`
}
