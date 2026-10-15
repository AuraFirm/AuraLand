package tier2

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// HashTree is a content hash of a directory: every path, its kind, its permission bits and its contents (a link's target
// for a link), in sorted order. It never follows a link and never reads a device or a pipe, so hashing what a hostile agent
// left behind cannot be turned into reading something else. Ownership and times are deliberately left out: they change with
// copying and do not mean the agent changed anything.
func HashTree(root string) (string, error) {
	var entries []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path != root {
			entries = append(entries, path)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(entries)
	h := sha256.New()
	for _, path := range entries {
		rel, _ := filepath.Rel(root, path)
		info, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%q %o ", rel, info.Mode().Perm())
		switch mode := info.Mode(); {
		case mode&fs.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return "", err
			}
			fmt.Fprintf(h, "link %q\n", target)
		case mode.IsDir():
			fmt.Fprint(h, "dir\n")
		case mode.IsRegular():
			sum, err := fileDigest(path)
			if err != nil {
				return "", err
			}
			fmt.Fprintf(h, "file %d %s\n", info.Size(), sum)
		default:
			// A device, pipe or socket: its existence is recorded, its contents are not read.
			fmt.Fprintf(h, "special %o\n", uint32(mode.Type()))
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func fileDigest(path string) (string, error) {
	f, err := openRead(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
