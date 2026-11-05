package agent

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// planTTL applies to both organise and rename plans: long enough to read
// a preview and decide, short enough that a forgotten preview can't be
// confirmed hours later against a vault that's since changed shape.
const planTTL = 10 * time.Minute

func newPlanID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "plan_" + hex.EncodeToString(b)
}

type planEntry[T any] struct {
	value     T
	expiresAt time.Time
}

// planStore holds pending plans of ONE kind in memory, keyed by ID. Safe
// for concurrent use; expired entries are garbage-collected lazily on
// access. agent.Service holds one instance per kind (organise, rename) —
// never a single shared instance — so an organise plan ID can never
// resolve against the rename store or vice versa.
type planStore[T any] struct {
	mu    sync.Mutex
	plans map[string]planEntry[T]
}

func newPlanStore[T any]() *planStore[T] {
	return &planStore[T]{plans: make(map[string]planEntry[T])}
}

func (st *planStore[T]) create(id string, value T) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.plans[id] = planEntry[T]{value: value, expiresAt: time.Now().Add(planTTL)}
}

func (st *planStore[T]) get(id string) (T, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	entry, ok := st.plans[id]
	if !ok || time.Now().After(entry.expiresAt) {
		delete(st.plans, id)
		var zero T
		return zero, false
	}
	return entry.value, true
}

func (st *planStore[T]) remove(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.plans, id)
}
