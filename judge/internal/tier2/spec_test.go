package tier2

import (
	"encoding/json"
	"strings"
	"testing"
)

func goodEnv() Env {
	return Env{
		Rootfs: "/var/lib/aura/rootfs/abc", Workspace: "/var/lib/aura/run/1/work", WorkDir: "/work",
		Argv: []string{"python", "agent.py"}, Env: []string{"LANG=C.UTF-8"}, UID: 1000, GID: 1000,
		Limits: Limits{WallSeconds: 60, MemoryMiB: 256, PIDs: 64, DiskMiB: 64, OutputKiB: 256},
	}
}

func TestSpecGrantsNothingAndNamesOnlyTheTwoHostPaths(t *testing.T) {
	raw, err := Spec(goodEnv())
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{`"readonly": true`, `"noNewPrivileges": true`, `"uid": 1000`, `"network"`} {
		if !strings.Contains(text, want) {
			t.Errorf("spec lacks %s", want)
		}
	}
	// No capability anywhere: every set is empty.
	caps := cfg["process"].(map[string]any)["capabilities"].(map[string]any)
	for name, set := range caps {
		if len(set.([]any)) != 0 {
			t.Errorf("capability set %s is not empty", name)
		}
	}
	// Host paths: the rootfs and the workspace, nothing else.
	hostPaths := 0
	for _, m := range cfg["mounts"].([]any) {
		source := m.(map[string]any)["source"].(string)
		if strings.HasPrefix(source, "/") {
			hostPaths++
			if source != "/var/lib/aura/run/1/work" {
				t.Errorf("unexpected host mount %s", source)
			}
		}
	}
	if hostPaths != 1 {
		t.Errorf("want exactly the workspace as a bind mount, got %d", hostPaths)
	}
	limits := cfg["linux"].(map[string]any)["resources"].(map[string]any)
	if limits["memory"].(map[string]any)["limit"].(float64) != 256*1024*1024 {
		t.Error("memory limit is not carried")
	}
	if limits["memory"].(map[string]any)["swap"].(float64) != 256*1024*1024 {
		t.Error("swap must equal memory so no swap is available")
	}
	if limits["pids"].(map[string]any)["limit"].(float64) != 64 {
		t.Error("pids limit is not carried")
	}
}

func TestValidateRefusesWhatCouldNotBeRunSafely(t *testing.T) {
	cases := map[string]func(*Env){
		"relative rootfs":    func(e *Env) { e.Rootfs = "rootfs" },
		"relative workspace": func(e *Env) { e.Workspace = "work" },
		"root as work dir":   func(e *Env) { e.WorkDir = "/" },
		"parent in work dir": func(e *Env) { e.WorkDir = "/work/../etc" },
		"no command":         func(e *Env) { e.Argv = nil },
		"NUL in argument":    func(e *Env) { e.Argv = []string{"sh\x00"} },
		"bad environment":    func(e *Env) { e.Env = []string{"NOEQUALS"} },
		"no memory limit":    func(e *Env) { e.Limits.MemoryMiB = 0 },
		"no wall limit":      func(e *Env) { e.Limits.WallSeconds = 0 },
		"root user":          func(e *Env) { e.UID = 0 },
		"root group":         func(e *Env) { e.GID = 0 },
	}
	for name, change := range cases {
		e := goodEnv()
		change(&e)
		if _, err := Spec(e); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if err := goodEnv().Validate(); err != nil {
		t.Errorf("a good environment was refused: %v", err)
	}
}
