// Package mutate makes small, deterministic changes to a reference solution (mutants). If a task's
// tests are strong, almost every mutant of a correct solution fails some test; the ones that survive
// show what the tests do not check. Mutants are text only: this package never runs anything, the
// sandbox does (internal/validate).
package mutate

import (
	"fmt"
	"strings"
)

// Mutant is the reference with exactly one change.
type Mutant struct {
	Operator string // what was swapped, for example "+ to -"
	Line     int    // 1-based line of the change
	Source   string
}

// MaxPerSolution bounds the sandbox work of one validation: each mutant is compiled and run on the
// tests, and a looping mutant costs a whole time limit. Forty keeps a job to minutes and is still enough
// to see whether the tests notice arithmetic, comparison and boundary mistakes.
const MaxPerSolution = 40

// site is one place where a change can be made: the byte range of a token and its replacement.
type site struct {
	start, end  int
	replacement string
	operator    string
}

// operators maps a token to its replacement. Multi-character tokens are matched before their prefixes
// (so "<=" is never read as "<" followed by "="), and tokens that are part of longer ones ("<<", "->",
// "++", "+=") are not mutated at all: they are I/O, pointers and updates, where a swap mostly makes
// the program not compile and says nothing about the tests.
var operators = map[string]string{
	"+": "-", "-": "+", "*": "+",
	"<=": "<", ">=": ">", "<": "<=", ">": ">=",
	"==": "!=", "!=": "==",
	"&&": "||", "||": "&&",
}

// untouchable multi-character tokens: read as a unit and left alone.
var untouchable = []string{"<<=", ">>=", "<<", ">>", "->", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "//", "=>", ":="}

var pythonWords = map[string]string{"and": "or", "or": "and"}

// Generate returns at most `max` mutants of the source, spread evenly over its mutation sites so the
// whole program is covered when there are more sites than the cap. language is "cpp" or "python3".
func Generate(language, source string, max int) ([]Mutant, error) {
	if language != "cpp" && language != "python3" {
		return nil, fmt.Errorf("no mutation rules for %q", language)
	}
	if max < 1 {
		return nil, fmt.Errorf("max must be positive, got %d", max)
	}
	sites := findSites(language, source)
	chosen := spread(len(sites), max)
	mutants := make([]Mutant, 0, len(chosen))
	for _, index := range chosen {
		s := sites[index]
		mutants = append(mutants, Mutant{
			Operator: s.operator,
			Line:     1 + strings.Count(source[:s.start], "\n"),
			Source:   source[:s.start] + s.replacement + source[s.end:],
		})
	}
	return mutants, nil
}

// spread picks up to max indices out of count, evenly, always including the first.
func spread(count, max int) []int {
	if count <= max {
		all := make([]int, count)
		for i := range all {
			all[i] = i
		}
		return all
	}
	picked := make([]int, 0, max)
	for i := 0; i < max; i++ {
		picked = append(picked, i*count/max)
	}
	return picked
}

// findSites scans the code once. It skips comments, string and character literals and (for C++)
// preprocessor lines, because a change there is not a change to the solution's logic.
func findSites(language, source string) []site {
	var sites []site
	for i := 0; i < len(source); {
		skipped := skipNonCode(language, source, i)
		if skipped > i {
			i = skipped
			continue
		}
		if token, ok := matchUntouchable(source, i); ok {
			i += len(token)
			continue
		}
		if s, ok := operatorSite(source, i); ok {
			sites = append(sites, s)
			i = s.end
			continue
		}
		if s, ok := wordSite(language, source, i); ok {
			sites = append(sites, s)
			i = s.end
			continue
		}
		if s, ok := numberSite(source, i); ok {
			sites = append(sites, s)
			i = s.end
			continue
		}
		i++
	}
	return sites
}

func skipNonCode(language, source string, i int) int {
	switch c := source[i]; {
	case c == '"' || c == '\'':
		return skipQuoted(source, i, c)
	case language == "cpp" && c == '/' && strings.HasPrefix(source[i:], "//"):
		return skipLine(source, i)
	case language == "cpp" && c == '/' && strings.HasPrefix(source[i:], "/*"):
		if end := strings.Index(source[i+2:], "*/"); end >= 0 {
			return i + 2 + end + 2
		}
		return len(source)
	case language == "python3" && c == '#':
		return skipLine(source, i)
	case language == "cpp" && c == '#' && onlySpaceBefore(source, i):
		return skipLine(source, i)
	}
	return i
}

func skipQuoted(source string, i int, quote byte) int {
	for j := i + 1; j < len(source); j++ {
		if source[j] == '\\' {
			j++
			continue
		}
		if source[j] == quote || source[j] == '\n' {
			return j + 1
		}
	}
	return len(source)
}

func skipLine(source string, i int) int {
	if end := strings.IndexByte(source[i:], '\n'); end >= 0 {
		return i + end
	}
	return len(source)
}

func onlySpaceBefore(source string, i int) bool {
	for j := i - 1; j >= 0 && source[j] != '\n'; j-- {
		if source[j] != ' ' && source[j] != '\t' {
			return false
		}
	}
	return true
}

func matchUntouchable(source string, i int) (string, bool) {
	for _, token := range untouchable {
		if strings.HasPrefix(source[i:], token) {
			return token, true
		}
	}
	return "", false
}

func operatorSite(source string, i int) (site, bool) {
	for _, length := range []int{2, 1} {
		if i+length > len(source) {
			continue
		}
		token := source[i : i+length]
		if replacement, ok := operators[token]; ok {
			return site{i, i + length, replacement, token + " to " + replacement}, true
		}
	}
	return site{}, false
}

func wordSite(language, source string, i int) (site, bool) {
	if language != "python3" || !isWordStart(source, i) {
		return site{}, false
	}
	end := i
	for end < len(source) && isWordByte(source[end]) {
		end++
	}
	if replacement, ok := pythonWords[source[i:end]]; ok {
		return site{i, end, replacement, source[i:end] + " to " + replacement}, true
	}
	return site{}, false
}

// numberSite changes an integer literal by one. Digits that are part of a name, a float or a larger
// literal (hex, exponent) are not touched.
func numberSite(source string, i int) (site, bool) {
	if source[i] < '0' || source[i] > '9' || !isWordStart(source, i) {
		return site{}, false
	}
	end := i
	for end < len(source) && source[end] >= '0' && source[end] <= '9' {
		end++
	}
	if end < len(source) && (isWordByte(source[end]) || source[end] == '.') || len(source[i:end]) > 9 {
		return site{}, false
	}
	value := 0
	for _, digit := range source[i:end] {
		value = value*10 + int(digit-'0')
	}
	return site{i, end, fmt.Sprint(value + 1), fmt.Sprintf("%d to %d", value, value+1)}, true
}

func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func isWordStart(source string, i int) bool {
	return i == 0 || !isWordByte(source[i-1]) && source[i-1] != '.'
}
