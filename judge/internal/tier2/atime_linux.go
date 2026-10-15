//go:build linux

package tier2

import (
	"os"
	"syscall"
	"time"
)

func atimeOf(info os.FileInfo) time.Time {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return time.Unix(int64(st.Atim.Sec), int64(st.Atim.Nsec))
	}
	return time.Time{}
}

// openRead opens a file for reading without updating its access time, so that looking at the agent's files (hashing them,
// scanning them) never looks like the agent reading them. O_NOATIME needs the file's owner or root, which the node has; when
// it is refused the file is opened normally and the access time may move.
func openRead(path string) (*os.File, error) {
	if f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOATIME, 0); err == nil {
		return f, nil
	}
	return os.Open(path)
}
