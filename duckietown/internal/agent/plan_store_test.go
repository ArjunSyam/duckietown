package agent

import (
	"testing"
	"time"
)

func TestPlanStoreCreateGetRemove(t *testing.T) {
	st := newPlanStore[string]()

	_, ok := st.get("missing")
	if ok {
		t.Fatal("expected get on missing id to return ok=false")
	}

	st.create("a", "hello")
	got, ok := st.get("a")
	if !ok || got != "hello" {
		t.Fatalf("get(%q) = (%q, %v), want (hello, true)", "a", got, ok)
	}

	st.remove("a")
	_, ok = st.get("a")
	if ok {
		t.Fatal("expected get after remove to return ok=false")
	}
}

func TestPlanStoreExpiry(t *testing.T) {
	st := newPlanStore[string]()
	st.create("a", "hello")

	// Force expiry without waiting on the real 10-minute TTL.
	st.mu.Lock()
	entry := st.plans["a"]
	entry.expiresAt = time.Now().Add(-time.Second)
	st.plans["a"] = entry
	st.mu.Unlock()

	_, ok := st.get("a")
	if ok {
		t.Fatal("expected expired entry to be gone")
	}
	if _, stillThere := st.plans["a"]; stillThere {
		t.Fatal("expected get to lazily garbage-collect the expired entry")
	}
}

func TestPlanStoreTwoInstancesAreIndependent(t *testing.T) {
	organise := newPlanStore[*OrganisePlan]()
	rename := newPlanStore[*RenamePlan]()

	organise.create("x", &OrganisePlan{ID: "x", TargetFolder: "foo"})
	if _, ok := rename.get("x"); ok {
		t.Fatal("an organise plan ID should never resolve against the rename store")
	}
}
