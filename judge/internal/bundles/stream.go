// Package bundles opens a task bundle on a judge node without the node ever parsing an archive: the
// download is checked against its SHA-256, the archive is opened by the TypeScript validator inside a
// box (packages/bundle/src/open.ts), and this package reads only the flat stream that program prints.
package bundles

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Limits on the stream, mirroring the control plane's bundle limits (packages/contracts/src/limits.ts):
// a stream above them can only come from a broken or hostile box, so it is refused, not truncated.
const (
	FilesMax     = 5_000
	FileBytesMax = 64 << 20
	PathBytesMax = 100
)

// Refused is the validator's own answer for a bundle it will not open.
type Refused struct{ Code, Detail string }

func (r *Refused) Error() string { return "bundle refused: " + r.Code + " " + r.Detail }

// Files are the verified contents of tests/ and solutions/ of one bundle.
type Files struct {
	byPath map[string][]byte
	order  []string
}

// Get returns a file's bytes, or false when the bundle has no such file.
func (f *Files) Get(path string) ([]byte, bool) {
	data, ok := f.byPath[path]
	return data, ok
}

// Paths lists the files in the order the stream gave them (byte order of the paths).
func (f *Files) Paths() []string { return append([]string(nil), f.order...) }

// ParseStream reads the stream documented in packages/bundle/src/open.ts. Everything is checked: the
// header, each record's size and SHA-256, the path prefix, duplicates, the count in the trailer, and that
// nothing follows it.
func ParseStream(stream []byte) (*Files, error) {
	line, rest, ok := nextLine(stream)
	if !ok {
		return nil, errors.New("opener output is empty or has no line end")
	}
	if refusal, isRefusal := strings.CutPrefix(line, "REFUSED "); isRefusal {
		if len(rest) != 0 {
			return nil, errors.New("opener output continues after a refusal")
		}
		code, detail, _ := strings.Cut(refusal, " ")
		return nil, &Refused{Code: code, Detail: detail}
	}
	if line != "AURA-OPEN 1" {
		return nil, errors.New("opener output has an unknown header")
	}
	files := &Files{byPath: map[string][]byte{}}
	for range FilesMax + 1 { // bounded: a trailer is expected within FilesMax records
		line, rest, ok = nextLine(rest)
		if !ok {
			return nil, errors.New("opener output ends inside a record")
		}
		if count, isTrailer := strings.CutPrefix(line, "END "); isTrailer {
			return finish(files, count, rest)
		}
		var err error
		if rest, err = readRecord(files, line, rest); err != nil {
			return nil, err
		}
	}
	return nil, errors.New("opener output has too many files")
}

func finish(files *Files, countText string, rest []byte) (*Files, error) {
	count, err := strconv.Atoi(countText)
	if err != nil || count != len(files.order) {
		return nil, errors.New("opener trailer count does not match the records")
	}
	if len(rest) != 0 {
		return nil, errors.New("opener output continues after its trailer")
	}
	return files, nil
}

func readRecord(files *Files, line string, rest []byte) ([]byte, error) {
	fields := strings.Split(line, " ")
	if len(fields) != 3 {
		return nil, errors.New("opener record header is malformed")
	}
	size, err := strconv.Atoi(fields[0])
	if err != nil || size < 0 || size > FileBytesMax || strconv.Itoa(size) != fields[0] {
		return nil, errors.New("opener record size is invalid")
	}
	path := fields[2]
	if len(path) == 0 || len(path) > PathBytesMax || !(strings.HasPrefix(path, "tests/") || strings.HasPrefix(path, "solutions/")) {
		return nil, fmt.Errorf("opener record path %q is not allowed", truncate(path))
	}
	if _, duplicate := files.byPath[path]; duplicate {
		return nil, fmt.Errorf("opener record %q appears twice", path)
	}
	if len(rest) < size+1 || rest[size] != '\n' {
		return nil, errors.New("opener record body is short or not terminated")
	}
	data := rest[:size]
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != fields[1] {
		return nil, fmt.Errorf("opener record %q does not match its SHA-256", path)
	}
	files.byPath[path] = data
	files.order = append(files.order, path)
	return rest[size+1:], nil
}

func nextLine(data []byte) (line string, rest []byte, ok bool) {
	end := bytes.IndexByte(data, '\n')
	if end < 0 || end > 512 {
		return "", nil, false
	}
	return string(data[:end]), data[end+1:], true
}

func truncate(text string) string {
	if len(text) > 40 {
		return text[:40]
	}
	return text
}
