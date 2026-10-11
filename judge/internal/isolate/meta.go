// Package isolate drives the `isolate` sandbox (github.com/ioi/isolate) on Linux judge nodes. The parts
// that decide things (meta parsing, verdict mapping, argument construction, language profiles) are
// pure and tested everywhere; the part that starts processes is in box_linux.go and has been compiled
// but NOT run on a KVM-capable judge node: see docs/stages/stage-3-plan.md section 2.
package isolate

import (
	"bufio"
	"fmt"
	"strconv"
	"strings"
)

// Meta is isolate's report on one run (its --meta file: key:value lines).
type Meta struct {
	CPUSeconds    float64 // time: CPU time of the program
	WallSeconds   float64 // time-wall
	MaxRSSKiB     int     // max-rss
	CgMemKiB      int     // cg-mem: peak memory of the control group
	ExitCode      int     // exitcode
	ExitSignal    int     // exitsig
	Killed        bool    // killed: isolate itself killed the program
	Status        string  // status: RE (non-zero exit), SG (signal), TO (timeout), XX (internal error); "" = ok
	Message       string  // message
	CgOOMKilled   bool    // cg-oom-killed: the cgroup's OOM killer fired
	HasExitCode   bool
	HasExitSignal bool
}

const (
	metaLinesMax = 64
	metaLineMax  = 1024
)

// ParseMeta reads a meta file. It is strict about shape (bounded size, key:value only) because the file
// is written by a program that ran next to hostile code; unknown keys are ignored, malformed numbers are
// an error, not a zero.
func ParseMeta(text string) (Meta, error) {
	var meta Meta
	scanner := bufio.NewScanner(strings.NewReader(text))
	scanner.Buffer(make([]byte, 0, metaLineMax), metaLineMax)
	for lines := 0; scanner.Scan(); lines++ {
		if lines >= metaLinesMax {
			return Meta{}, fmt.Errorf("meta has more than %d lines", metaLinesMax)
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return Meta{}, fmt.Errorf("meta line without a colon: %q", truncate(line))
		}
		if err := meta.set(key, value); err != nil {
			return Meta{}, err
		}
	}
	if err := scanner.Err(); err != nil {
		return Meta{}, fmt.Errorf("meta: %w", err)
	}
	return meta, nil
}

func truncate(text string) string {
	if len(text) > 80 {
		return text[:80]
	}
	return text
}

func (m *Meta) set(key, value string) error {
	var err error
	switch key {
	case "time":
		m.CPUSeconds, err = strconv.ParseFloat(value, 64)
	case "time-wall":
		m.WallSeconds, err = strconv.ParseFloat(value, 64)
	case "max-rss":
		m.MaxRSSKiB, err = strconv.Atoi(value)
	case "cg-mem":
		m.CgMemKiB, err = strconv.Atoi(value)
	case "exitcode":
		m.ExitCode, err = strconv.Atoi(value)
		m.HasExitCode = true
	case "exitsig":
		m.ExitSignal, err = strconv.Atoi(value)
		m.HasExitSignal = true
	case "killed":
		m.Killed = value == "1"
	case "cg-oom-killed":
		m.CgOOMKilled = value == "1"
	case "status":
		m.Status = value
	case "message":
		m.Message = value
	}
	if err != nil {
		return fmt.Errorf("meta %s: %w", key, err)
	}
	return nil
}
