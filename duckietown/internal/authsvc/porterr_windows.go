//go:build windows

package authsvc

import (
	"errors"
	"syscall"
)

// Real Windows Sockets error codes, as returned by bind() itself. These are
// NOT the same as the stdlib syscall.EACCES/EADDRINUSE constants on
// Windows — those are "invented" values (see zerrors_windows.go) used only
// to give package os POSIX-style semantics, and never match what a raw
// socket syscall actually returns. syscall.WSAEACCES is already defined by
// the stdlib; WSAEADDRINUSE is not, so it's defined here directly.
const (
	wsaEAccess    = syscall.WSAEACCES
	wsaEAddrInUse = syscall.Errno(10048) // WSAEADDRINUSE
)

// isAddrInUse reports whether err is a genuine "address already in use"
// bind failure (another process — possibly another Duckietown instance —
// holds the port).
func isAddrInUse(err error) bool {
	return errors.Is(err, wsaEAddrInUse)
}

// isAccessForbidden reports whether err is WSAEACCES: Windows refused the
// bind outright, which on the ephemeral/dynamic port range (49152-65535)
// typically means Hyper-V, WSL2, or Docker's winnat has reserved the port
// and no process may bind it — not that anything is "in use".
func isAccessForbidden(err error) bool {
	return errors.Is(err, wsaEAccess)
}
