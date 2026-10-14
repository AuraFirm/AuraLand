package isolate

import (
	"fmt"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

// Profile says how to build and run one language. Profiles are data, versioned with the agent; adding
// a language is adding a profile and its tests, never new control flow.
type Profile struct {
	Language   string
	SourceName string
	// Compile is the command run in its own box; nil for interpreted languages.
	Compile []string
	// Run is the command that runs the program in a fresh box. {program} stands for the artifact.
	Run []string
	// Processes is the process limit inside the box (compilers need more than programs).
	CompileProcesses int
	RunProcesses     int
	Environment      []string
	// Directories are read-only host paths made visible at the same path in the box.
	Directories []string
	Version     string
}

// NodeRoot is where the node operator installs the pinned Node used to open bundles. Only that tree is
// visible in the box, read-only.
const NodeRoot = "/opt/aura/node"

var profiles = map[string]Profile{
	// The bundle opener (Stage 4B): the TypeScript validator, built into one file, run by a pinned Node.
	// Not a language a participant can pick: judge.Run refuses sandbox.OpenerLanguage.
	// The delivery watermark rewriter (Stage 4C): the same pinned Node, a different program.
	sandbox.RewriterLanguage: {
		Language:     sandbox.RewriterLanguage,
		SourceName:   "main.cjs",
		Run:          []string{NodeRoot + "/bin/node", "--max-old-space-size=768", "main.cjs"},
		RunProcesses: 32,
		Environment:  []string{"PATH=/usr/bin:/bin", "LANG=C"},
		Directories:  []string{NodeRoot},
		Version:      "rewriter-1",
	},
	sandbox.OpenerLanguage: {
		Language:     sandbox.OpenerLanguage,
		SourceName:   "main.cjs",
		Run:          []string{NodeRoot + "/bin/node", "--max-old-space-size=768", "main.cjs"},
		RunProcesses: 32, // Node starts several helper threads; a process limit of 1 would kill it.
		Environment:  []string{"PATH=/usr/bin:/bin", "LANG=C"},
		Directories:  []string{NodeRoot},
		Version:      "opener-1",
	},
	"cpp": {
		Language:         "cpp",
		SourceName:       "main.cpp",
		Compile:          []string{"/usr/bin/g++", "-std=c++20", "-O2", "-pipe", "-static", "-o", "main", "main.cpp"},
		Run:              []string{"./main"},
		CompileProcesses: 16,
		RunProcesses:     1,
		Environment:      []string{"PATH=/usr/bin:/bin", "LANG=C"},
		Version:          "cpp-1",
	},
	"python3": {
		Language:     "python3",
		SourceName:   "main.py",
		Run:          []string{"/usr/bin/python3", "-S", "-B", "main.py"},
		RunProcesses: 1,
		Environment:  []string{"PATH=/usr/bin:/bin", "LANG=C", "PYTHONDONTWRITEBYTECODE=1"},
		Version:      "python3-1",
	},
}

// ProfileFor returns the profile of a language, or an error for one this node cannot judge.
func ProfileFor(language string) (Profile, error) {
	profile, ok := profiles[language]
	if !ok {
		return Profile{}, fmt.Errorf("no profile for language %q", language)
	}
	return profile, nil
}
