//go:build !linux

package tier2

import (
	"os"
	"time"
)

// Access times are only read on Linux, where the sandbox runs; elsewhere there is no honeypot-read signal.
func atimeOf(os.FileInfo) time.Time { return time.Time{} }

func openRead(path string) (*os.File, error) { return os.Open(path) }
