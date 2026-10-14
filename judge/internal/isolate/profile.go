package isolate

import (
	"fmt"
	"runtime"
	"strconv"
	"strings"

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
	// A runtime that costs something before the program starts (a JVM) gets that cost back, so the task's
	// limits stay the program's own: TimeAllowanceMS is added to the CPU and wall limits of a run, and
	// MemoryReserveKiB of the memory limit is kept for the runtime itself: the heap placeholder in Run is
	// what is left. Zero for languages that start for free.
	TimeAllowanceMS  int
	MemoryReserveKiB int
}

// heapMiBMin keeps a tiny memory limit from producing a heap the runtime refuses to start with.
const heapMiBMin = 16

// forRun returns the limits a run is held to and the command with its placeholders filled: {heap_mib} is
// the memory limit less the runtime's reserve. The memory limit itself is never raised: the cgroup limit
// stays what the task says, so a program that outgrows its heap is stopped by the same limit as any other.
func (p Profile) forRun(limits sandbox.Limits) (sandbox.Limits, []string) {
	adjusted := limits
	adjusted.CPUMS += p.TimeAllowanceMS
	adjusted.WallMS += p.TimeAllowanceMS
	heap := (limits.MemoryKiB - p.MemoryReserveKiB) / 1024
	if heap < heapMiBMin {
		heap = heapMiBMin
	}
	command := make([]string, len(p.Run))
	for i, part := range p.Run {
		command[i] = strings.ReplaceAll(part, "{heap_mib}", strconv.Itoa(heap))
	}
	return adjusted, command
}

// NodeRoot is where the node operator installs the pinned Node used to open bundles. Only that tree is
// visible in the box, read-only.
const NodeRoot = "/opt/aura/node"

// javaHome is the JDK the node operator installs (OpenJDK 21 from the distribution). It lives under /usr, which
// the box already shows read-only, so no extra mount is needed.
var javaHome = "/usr/lib/jvm/java-21-openjdk-" + javaArchitecture()

// The distribution names the JDK directory by its own architecture names, not Go's.
func javaArchitecture() string {
	if runtime.GOARCH == "arm64" {
		return "arm64"
	}
	return "amd64"
}

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
	// C (Stage 5): gcc in the same box and with the same limits as C++. gnu17 and not strict c17 so the POSIX
	// declarations contestants expect (getline, strdup) exist; -lm because math is part of C, not of libc.
	"c": {
		Language:         "c",
		SourceName:       "main.c",
		Compile:          []string{"/usr/bin/gcc", "-std=gnu17", "-O2", "-pipe", "-static", "-o", "main", "main.c", "-lm"},
		Run:              []string{"./main"},
		CompileProcesses: 16,
		RunProcesses:     1,
		Environment:      []string{"PATH=/usr/bin:/bin", "LANG=C"},
		Version:          "c-1",
	},
	// Java 21 (Stage 5). A contestant writes `public class Main`; the compile step builds a jar whose entry
	// point is Main, and the box runs it with a bounded heap, one serial collector and no attach/perf files
	// (those want a writable /tmp). The JVM costs about a second of start-up, which the task is not charged
	// for (TimeAllowanceMS), and about 64 MiB of non-heap memory, which comes out of the task's limit
	// (MemoryReserveKiB) so the cgroup limit stays exactly what the task says. -proc:none switches off
	// annotation processors: they would run contestant code inside the compiler.
	"java": {
		Language:   "java",
		SourceName: "Main.java",
		Compile: []string{
			"/bin/sh", "-c",
			javaHome + "/bin/javac -J-XX:+UseSerialGC -J-Xmx384m -J-Xss8m -J-XX:TieredStopAtLevel=1 -encoding UTF-8 -proc:none -d . Main.java && " +
				javaHome + "/bin/jar --create --file main --main-class Main *.class",
		},
		Run: []string{
			javaHome + "/bin/java", "-Xmx{heap_mib}m", "-Xms16m", "-Xss16m", "-XX:+UseSerialGC", "-XX:CICompilerCount=2",
			"-XX:-UsePerfData", "-XX:+DisableAttachMechanism", "-Xshare:auto", "-Dfile.encoding=UTF-8", "-jar", "main",
		},
		CompileProcesses: 128,
		RunProcesses:     64,
		Environment:      []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"},
		// The JDK's own configuration (security and logging settings) lives in /etc, which the box does not
		// show; only that one directory is added, read-only, and nothing else of /etc.
		Directories:      []string{"/etc/java-21-openjdk"},
		Version:          "java-1",
		TimeAllowanceMS:  1000,
		MemoryReserveKiB: 64 * 1024,
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
