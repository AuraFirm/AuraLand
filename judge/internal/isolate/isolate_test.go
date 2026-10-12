package isolate

import (
	"slices"
	"strings"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

func TestMetaOfANormalRun(t *testing.T) {
	meta, err := ParseMeta("time:0.012\ntime-wall:0.034\nmax-rss:2048\ncg-mem:2560\nexitcode:0\ncsw-voluntary:3\n")
	if err != nil {
		t.Fatal(err)
	}
	if meta.CPUSeconds != 0.012 || meta.WallSeconds != 0.034 || meta.MaxRSSKiB != 2048 || meta.CgMemKiB != 2560 || !meta.HasExitCode || meta.ExitCode != 0 || meta.Status != "" {
		t.Fatalf("%+v", meta)
	}
}

func TestMetaOfFailures(t *testing.T) {
	cases := map[string]Meta{
		"status:TO\nmessage:Time limit exceeded\nkilled:1\ntime:1.2": {Status: "TO", Message: "Time limit exceeded", Killed: true, CPUSeconds: 1.2},
		"status:SG\nexitsig:11\nmessage:Caught fatal signal 11":      {Status: "SG", ExitSignal: 11, HasExitSignal: true, Message: "Caught fatal signal 11"},
		"status:RE\nexitcode:1\nmessage:Exited with error status 1":  {Status: "RE", ExitCode: 1, HasExitCode: true, Message: "Exited with error status 1"},
		"cg-oom-killed:1\nstatus:SG\nexitsig:9":                      {CgOOMKilled: true, Status: "SG", ExitSignal: 9, HasExitSignal: true},
	}
	for text, want := range cases {
		got, err := ParseMeta(text)
		if err != nil || got != want {
			t.Errorf("%q: got %+v err %v, want %+v", text, got, err, want)
		}
	}
}

func TestMalformedMetaIsAnErrorNotAZero(t *testing.T) {
	for _, text := range []string{"time:abc", "no colon here", "exitcode:", "max-rss:1.5", strings.Repeat("a:1\n", 65), "message:" + strings.Repeat("x", 2000)} {
		if _, err := ParseMeta(text); err == nil {
			t.Errorf("%.30q should be refused", text)
		}
	}
	if meta, err := ParseMeta("unknown-key:whatever\ntime:0.5"); err != nil || meta.CPUSeconds != 0.5 {
		t.Errorf("unknown keys are ignored: %+v %v", meta, err)
	}
}

var limits = sandbox.Limits{CPUMS: 1000, WallMS: 3000, MemoryKiB: 262144, OutputKiB: 1024}

func TestVerdictMapping(t *testing.T) {
	cases := []struct {
		name   string
		meta   Meta
		output int
		want   string
	}{
		{"ok", Meta{CPUSeconds: 0.2}, 10, "OK"},
		{"timeout", Meta{Status: "TO", Killed: true}, 0, "TLE"},
		{"cpu over limit without status", Meta{CPUSeconds: 1.2}, 0, "TLE"},
		{"memory by oom", Meta{CgOOMKilled: true, Status: "SG", ExitSignal: 9}, 0, "MLE"},
		{"memory by peak", Meta{CgMemKiB: 300000}, 0, "MLE"},
		{"output flood", Meta{}, 2 * 1024 * 1024, "OLE"},
		{"file size limit signal", Meta{Status: "SG", ExitSignal: 25, HasExitSignal: true}, 0, "OLE"},
		{"crash by signal", Meta{Status: "SG", ExitSignal: 11}, 0, "RTE"},
		{"non-zero exit", Meta{Status: "RE", ExitCode: 1}, 0, "RTE"},
		{"sandbox failure", Meta{Status: "XX"}, 0, "SE"},
		{"unknown status", Meta{Status: "??"}, 0, "SE"},
		// Priorities: an OOM kill ends with SIGKILL and must not look like a crash; the sandbox's own
		// failure beats everything else.
		{"oom beats signal", Meta{CgOOMKilled: true, Status: "SG"}, 0, "MLE"},
		{"timeout beats signal", Meta{Status: "TO", Killed: true, ExitSignal: 9}, 0, "TLE"},
		{"internal error beats time", Meta{Status: "XX", CPUSeconds: 9}, 0, "SE"},
	}
	for _, c := range cases {
		if got := Verdict(c.meta, limits, c.output); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

func TestRunArgumentsAlwaysIsolate(t *testing.T) {
	args, err := RunArgs(7, limits, limits.OutputKiB, 1, "/box/meta", "/box/in", "/box/out", "/box/err", []string{"PATH=/usr/bin"}, nil, []string{"./main"})
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"--cg", "--box-id=7", "--cg-mem=262144", "--processes=1", "--time=1.000", "--wall-time=3.000", "--fsize=1024", "--meta=/box/meta", "--stdin=/box/in", "--run"} {
		if !slices.Contains(args, required) {
			t.Errorf("missing %s in %v", required, args)
		}
	}
	merged, err := RunArgs(7, limits, CompileFileKiBMax, 16, "/box/meta", "/box/in", "/box/out", "", nil, nil, []string{"g++"})
	if err != nil || !slices.Contains(merged, "--stderr-to-stdout") || !slices.Contains(merged, "--fsize=32768") {
		t.Errorf("a compile merges stderr and may write a program: %v %v", merged, err)
	}
	for _, forbidden := range []string{"--share-net", "--no-cg", "--cg-timing"} {
		if slices.Contains(args, forbidden) {
			t.Errorf("%s must never be passed", forbidden)
		}
	}
	if args[len(args)-1] != "./main" || args[len(args)-2] != "--" {
		t.Errorf("the command goes last, after --: %v", args)
	}
	if !slices.Contains(InitArgs(7), "--cg") || !slices.Contains(CleanupArgs(7), "--cleanup") {
		t.Error("init and cleanup use the cgroup too")
	}
}

func TestBadArgumentsAreRefused(t *testing.T) {
	if _, err := RunArgs(-1, limits, 1, 1, "m", "i", "o", "e", nil, nil, []string{"x"}); err == nil {
		t.Error("negative box id")
	}
	if _, err := RunArgs(BoxIDMax+1, limits, 1, 1, "m", "i", "o", "e", nil, nil, []string{"x"}); err == nil {
		t.Error("box id too large")
	}
	if _, err := RunArgs(1, sandbox.Limits{}, 1, 1, "m", "i", "o", "e", nil, nil, []string{"x"}); err == nil {
		t.Error("zero limits must never mean unlimited")
	}
	if _, err := RunArgs(1, limits, 1, 0, "m", "i", "o", "e", nil, nil, nil); err == nil {
		t.Error("no processes / no command")
	}
}

func TestProfiles(t *testing.T) {
	cpp, err := ProfileFor("cpp")
	if err != nil || cpp.Compile == nil || cpp.RunProcesses != 1 {
		t.Fatalf("%+v %v", cpp, err)
	}
	python, err := ProfileFor("python3")
	if err != nil || python.Compile != nil {
		t.Fatalf("%+v %v", python, err)
	}
	if _, err := ProfileFor("brainfuck"); err == nil {
		t.Fatal("an unknown language has no profile")
	}
	for _, p := range []Profile{cpp, python} {
		if !slices.ContainsFunc(p.Environment, func(e string) bool { return strings.HasPrefix(e, "PATH=") }) {
			t.Errorf("%s: the environment is explicit", p.Language)
		}
	}
}

// Mounts are read-only and only a profile can ask for one: submissions have none, the opener has Node.
func TestDirectoriesAreMountedReadOnlyAndOnlyForTheOpener(t *testing.T) {
	args, err := RunArgs(1, limits, 1024, 32, "m", "i", "o", "e", nil, []string{NodeRoot}, []string{"node"})
	if err != nil || !slices.Contains(args, "--dir="+NodeRoot) {
		t.Fatalf("%v %v", args, err)
	}
	for _, arg := range args {
		if strings.Contains(arg, ":rw") {
			t.Errorf("a mount must never be writable: %s", arg)
		}
	}
	for _, language := range []string{"cpp", "python3"} {
		profile, err := ProfileFor(language)
		if err != nil || len(profile.Directories) != 0 {
			t.Errorf("%s must have no extra mounts: %+v %v", language, profile, err)
		}
	}
}
