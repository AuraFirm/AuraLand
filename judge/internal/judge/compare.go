package judge

import (
	"math"
	"strconv"
	"strings"
)

// Compare decides whether a program's output matches the jury's answer for a built-in checker type.
// "custom" checkers are programs from the bundle and run in a sandbox box, not here.
func Compare(checker string, got, want []byte) (bool, bool) {
	switch checker {
	case "exact":
		return normalizeLines(got) == normalizeLines(want), true
	case "tokens":
		return equalTokens(got, want, false), true
	case "float":
		return equalTokens(got, want, true), true
	default:
		return false, false
	}
}

// exact ignores trailing whitespace on each line and trailing blank lines, which no sane task treats
// as a difference, and nothing else.
func normalizeLines(data []byte) string {
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \t\r")
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}

const floatTolerance = 1e-6

func equalTokens(got, want []byte, numeric bool) bool {
	a, b := strings.Fields(string(got)), strings.Fields(string(want))
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] == b[i] {
			continue
		}
		if !numeric {
			return false
		}
		x, errX := strconv.ParseFloat(a[i], 64)
		y, errY := strconv.ParseFloat(b[i], 64)
		if errX != nil || errY != nil || math.IsNaN(x) || math.IsNaN(y) {
			return false
		}
		if math.Abs(x-y) > floatTolerance*math.Max(1, math.Abs(y)) {
			return false
		}
	}
	return true
}
