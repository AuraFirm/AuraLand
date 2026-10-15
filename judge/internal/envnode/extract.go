// Package envnode runs an environment on a Tier-2 node: it fetches the environment's image and hidden material, checks
// their hashes, lays them out, runs the agent's session and the verifier in sandboxes, and signs the trace.
package envnode

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Limits on an archive. They protect the node from a hostile or broken tar, not from a large image.
type ExtractLimits struct {
	Entries int
	Bytes   int64
	Depth   int
}

var DefaultLimits = ExtractLimits{Entries: 200_000, Bytes: 4 << 30, Depth: 64}

// Extract unpacks a tar into dir: regular files, directories and symbolic links only. The rules, each of which a test
// breaks on purpose:
//   - a name must stay inside dir (no absolute path, no ".." segment);
//   - nothing is ever written THROUGH a symbolic link: every parent directory of an entry is checked with Lstat first, so a
//     link created by the archive cannot redirect a later entry out of dir;
//   - devices, pipes and sockets are skipped (the sandbox provides its own /dev), a hard link is copied from an
//     already extracted regular file inside dir (never linked, so no inode is shared), and refused otherwise;
//   - entry count, total bytes and depth are capped.
//
// A link's target is stored as written: it is only ever followed inside the sandbox, where the root is read-only.
//
// NOTE (cutlist F70): the repository rule is that archives are parsed only inside a sandbox. This extractor is hardened and
// tested, and the archive comes from an organization's author rather than from a candidate, but it does run in the agent's
// process. Moving it into a Tier-1 box is the follow-up.
func Extract(r io.Reader, dir string, limits ExtractLimits) error {
	reader := tar.NewReader(r)
	var entries int
	var total int64
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("extract: %w", err)
		}
		entries++
		if entries > limits.Entries {
			return fmt.Errorf("extract: more than %d entries", limits.Entries)
		}
		name, err := cleanName(header.Name, limits.Depth)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		target := filepath.Join(dir, name)
		if err := noLinkInParents(dir, target); err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			total += header.Size
			if total > limits.Bytes {
				return fmt.Errorf("extract: more than %d bytes", limits.Bytes)
			}
			if err := writeFile(reader, target, header.FileInfo().Mode().Perm()); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		case tar.TypeLink:
			size, err := copyHardLink(dir, target, header, limits.Depth)
			if err != nil {
				return err
			}
			total += size
			if total > limits.Bytes {
				return fmt.Errorf("extract: more than %d bytes", limits.Bytes)
			}
		default:
			// devices, pipes, sockets: not created.
		}
	}
}

// copyHardLink makes target a copy of the regular file the link names. Real images use hard links (Debian's /bin/adduser),
// so refusing them would refuse the images. Copying instead of linking keeps every file its own inode.
func copyHardLink(dir, target string, header *tar.Header, depthMax int) (int64, error) {
	linkName, err := cleanName(header.Linkname, depthMax)
	if err != nil || linkName == "" {
		return 0, fmt.Errorf("extract: hard link %q has a bad target %q", header.Name, header.Linkname)
	}
	source := filepath.Join(dir, linkName)
	if err := noLinkInParents(dir, source); err != nil {
		return 0, err
	}
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() {
		return 0, fmt.Errorf("extract: hard link %q targets %q, which is not an extracted regular file", header.Name, header.Linkname)
	}
	file, err := os.Open(source)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	if err := writeFile(file, target, info.Mode().Perm()); err != nil {
		return 0, err
	}
	return info.Size(), nil
}

func cleanName(name string, depthMax int) (string, error) {
	if strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("extract: %q is absolute", name)
	}
	clean := filepath.Clean(name)
	if clean == "." {
		return "", nil
	}
	parts := strings.Split(clean, string(filepath.Separator))
	if len(parts) > depthMax {
		return "", fmt.Errorf("extract: %q is deeper than %d levels", name, depthMax)
	}
	for _, part := range parts {
		if part == ".." {
			return "", fmt.Errorf("extract: %q leaves the directory", name)
		}
	}
	return clean, nil
}

// noLinkInParents refuses an entry whose path passes through a symbolic link that already exists.
func noLinkInParents(root, target string) error {
	rel, err := filepath.Rel(root, filepath.Dir(target))
	if err != nil || rel == "." {
		return err
	}
	current := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("extract: %q passes through a link", target)
		}
	}
	return nil
}

func writeFile(r io.Reader, target string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	// O_EXCL | O_NOFOLLOW: an entry never overwrites or follows anything that is already there.
	_ = os.Remove(target)
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode|0o400)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, r)
	return err
}
