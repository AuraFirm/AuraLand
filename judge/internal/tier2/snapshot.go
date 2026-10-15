package tier2

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// Limits on what a snapshot may hold. They are caps on hostile output, not features.
const (
	snapshotFilesMax   = 20000
	snapshotDepthMax   = 32
	snapshotDroppedMax = 100
)

// SnapshotReport says what a snapshot kept and what it refused to carry over.
type SnapshotReport struct {
	Files   int
	Bytes   int64
	Dropped []string // relative paths of links, devices, pipes and sockets that were not copied (capped)
}

// Snapshot copies the regular files and directories under src into dst and nothing else. A link the agent left is NOT
// carried over: inside the verifier's sandbox a link would resolve against the verifier's own file system, so an agent could
// point `answer.txt` at the hidden expected answer and be graded on the verifier's own data (a reward hack the sandbox cannot
// see, because the link is only a name). Dropped names are returned as evidence. Permission bits are normalized so the copy
// is readable but never executable by accident.
func Snapshot(src, dst string, bytesMax int64) (SnapshotReport, error) {
	var report SnapshotReport
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return report, err
	}
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == src {
			return nil
		}
		rel, _ := filepath.Rel(src, path)
		if depth(rel) > snapshotDepthMax {
			return fmt.Errorf("snapshot: %q is deeper than %d levels", rel, snapshotDepthMax)
		}
		switch mode := d.Type(); {
		case mode.IsDir():
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		case mode.IsRegular():
			report.Files++
			if report.Files > snapshotFilesMax {
				return fmt.Errorf("snapshot: more than %d files", snapshotFilesMax)
			}
			n, err := copyRegular(path, filepath.Join(dst, rel), bytesMax-report.Bytes)
			report.Bytes += n
			return err
		default:
			if len(report.Dropped) < snapshotDroppedMax {
				report.Dropped = append(report.Dropped, rel)
			}
			return nil
		}
	})
	sort.Strings(report.Dropped)
	return report, err
}

func depth(rel string) int {
	n := 1
	for _, c := range rel {
		if c == filepath.Separator {
			n++
		}
	}
	return n
}

func copyRegular(from, to string, room int64) (int64, error) {
	in, err := os.Open(from)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, err
	}
	defer out.Close()
	if room < 0 {
		room = 0
	}
	n, err := io.Copy(out, io.LimitReader(in, room+1))
	if err == nil && n > room {
		err = fmt.Errorf("snapshot: more than the allowed bytes")
	}
	return n, err
}
