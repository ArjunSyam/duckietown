//go:build !windows

package authsvc

import (
	"errors"
	"syscall"
)

// On non-Windows platforms the kernel's errno values already match the
// stdlib syscall constants, so the plain POSIX check is accurate.

func isAddrInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}

func isAccessForbidden(err error) bool {
	return errors.Is(err, syscall.EACCES)
}
