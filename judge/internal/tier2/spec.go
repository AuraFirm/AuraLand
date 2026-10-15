package tier2

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var cgroupNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

// Spec renders the OCI runtime configuration for one run. It is a pure function of the Env so that what the sandbox
// is told can be tested without a sandbox: no host path appears except the two the Env names, no capability is
// granted, the root is read-only, there is no network, and every limit the Env carries is in it.
func Spec(e Env) ([]byte, error) {
	if err := e.Validate(); err != nil {
		return nil, err
	}
	if e.CgroupName != "" && !cgroupNamePattern.MatchString(e.CgroupName) {
		return nil, fmt.Errorf("invalid cgroup name")
	}
	const mib = 1 << 20
	memory := int64(e.Limits.MemoryMiB) * mib
	none := []string{}
	mounts := []map[string]any{
		{"destination": "/proc", "type": "proc", "source": "proc"},
		{"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": []string{"nosuid", "nodev", "noexec", fmt.Sprintf("size=%dm", e.Limits.DiskMiB)}},
		{"destination": e.WorkDir, "type": "bind", "source": e.Workspace, "options": []string{"rbind", "rw", "nosuid", "nodev"}},
	}
	for _, m := range e.Mounts {
		mounts = append(mounts, map[string]any{"destination": m.Dest, "type": "bind", "source": m.Host, "options": []string{"rbind", "ro", "nosuid", "nodev", "noexec"}})
	}
	cfg := map[string]any{
		"ociVersion": "1.0.2",
		"process": map[string]any{
			"terminal": false,
			"user":     map[string]any{"uid": e.UID, "gid": e.GID},
			"args":     e.Argv,
			"env":      append([]string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + e.WorkDir}, e.Env...),
			"cwd":      e.WorkDir,
			"capabilities": map[string]any{
				"bounding": none, "effective": none, "inheritable": none, "permitted": none, "ambient": none,
			},
			"rlimits": []map[string]any{
				{"type": "RLIMIT_NOFILE", "hard": 512, "soft": 512},
				{"type": "RLIMIT_CORE", "hard": 0, "soft": 0},
				{"type": "RLIMIT_FSIZE", "hard": int64(e.Limits.DiskMiB) * mib, "soft": int64(e.Limits.DiskMiB) * mib},
			},
			"noNewPrivileges": true,
		},
		"root":     map[string]any{"path": e.Rootfs, "readonly": true},
		"hostname": "env",
		"mounts":   mounts,
		"linux": map[string]any{
			"namespaces": []map[string]string{{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}, {"type": "network"}},
			"resources": map[string]any{
				"memory": map[string]any{"limit": memory, "swap": memory},
				"pids":   map[string]any{"limit": e.Limits.PIDs},
			},
		},
	}
	if e.CgroupName != "" {
		cfg["linux"].(map[string]any)["cgroupsPath"] = "/aura/" + e.CgroupName
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// RunPID reads the process id out of a run's name ("aura-<pid>-<counter>", made by the GVisor driver). The startup sweep uses it to
// tell a run that belongs to a node still alive from one a dead node left behind. ok is false for any other name, which the sweep
// must never touch.
func RunPID(name string) (pid int, ok bool) {
	parts := strings.Split(name, "-")
	if len(parts) != 3 || parts[0] != "aura" {
		return 0, false
	}
	pid, err := strconv.Atoi(parts[1])
	if err != nil || pid <= 0 || strconv.Itoa(pid) != parts[1] {
		return 0, false
	}
	if n, err := strconv.Atoi(parts[2]); err != nil || n <= 0 || strconv.Itoa(n) != parts[2] {
		return 0, false
	}
	return pid, true
}
