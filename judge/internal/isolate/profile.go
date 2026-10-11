package isolate

import "fmt"

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
	Version          string
}

var profiles = map[string]Profile{
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
