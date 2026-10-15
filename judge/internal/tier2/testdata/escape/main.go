// escape is the Tier-2 escape suite's hostile program (Stage 8 slice 2). Each subcommand tries one way out of a
// sandbox and exits 3 if it WORKED ("escaped"), 0 if the sandbox refused or hid it ("contained"), 2 for a probe that
// could not even run. The suite runs every probe inside the sandbox (all must exit 0) and again unconfined as root
// on the same machine (every probe except the ones named in the test must exit 3), so a pass means "contained", not
// "broken". The probes only look and ask; none changes anything that matters if it succeeds on a development VM.
package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"syscall"
	"time"
	"unsafe"
)

const (
	escaped   = 3
	contained = 0
	unusable  = 2
)

var probes = map[string]func() int{
	"chroot":      func() int { return exitIf(syscall.Chroot("/") == nil) },
	"mount":       mountOver,
	"network":     network,
	"host_canary": hostCanary,
	"ptrace":      ptraceVictim,
	"raw_socket":  rawSocket,
	"setuid_root": func() int { return exitIf(syscall.Setuid(0) == nil && syscall.Getuid() == 0) },
	"write_etc":   writeEtc,
	"dev_mem":     func() int { return openAny("/dev/mem", "/dev/kmsg", "/dev/port") },
	"kcore":       func() int { return openAny("/proc/kcore", "/proc/kallsyms-writable") },
	"mknod":       mknod,
	"init_module": initModule,
	"host_pid":    hostPID,
	"host_cgroup": hostCgroup,
	"reboot":      func() int { return exitIf(syscall.Reboot(syscall.LINUX_REBOOT_CMD_CAD_OFF) == nil) },
	"disk_fill":   diskFill,
}

func exitIf(worked bool) int {
	if worked {
		return escaped
	}
	return contained
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: escape <probe>")
		os.Exit(unusable)
	}
	if os.Args[1] == "list" {
		for name := range probes {
			fmt.Println(name)
		}
		return
	}
	probe, ok := probes[os.Args[1]]
	if !ok {
		fmt.Fprintln(os.Stderr, "unknown probe")
		os.Exit(unusable)
	}
	os.Exit(probe())
}

// The mount goes over the probe's own work directory and is taken off again, so the unconfined control never changes
// what the rest of the machine sees (an earlier version mounted over /tmp and hid the control's own files).
func mountOver() int {
	dir := workDir()
	if syscall.Mount("none", dir, "tmpfs", 0, "") != nil {
		return contained
	}
	_ = syscall.Unmount(dir, 0)
	return escaped
}

// A harmless process the test started on the host, outside the sandbox. Attaching to it, or signalling it, is reaching the host.
func victim() (int, bool) {
	pid, err := strconv.Atoi(os.Getenv("AURA_VICTIM_PID"))
	return pid, err == nil && pid > 1
}

func ptraceVictim() int {
	pid, ok := victim()
	if !ok {
		return unusable
	}
	if syscall.PtraceAttach(pid) != nil {
		return contained
	}
	_ = syscall.PtraceDetach(pid)
	return escaped
}

func network() int {
	conn, err := net.DialTimeout("tcp", "1.1.1.1:53", 1500*time.Millisecond)
	if err == nil {
		conn.Close()
	}
	return exitIf(err == nil)
}

// The host puts a file with a random name outside the root file system and the workspace; reaching it by any path is an
// escape.
func hostCanary() int {
	canary := os.Getenv("AURA_CANARY")
	if canary == "" {
		return unusable
	}
	for _, path := range []string{canary, "/proc/1/root" + canary, "/proc/self/root" + canary, "/host" + canary} {
		if f, err := os.Open(path); err == nil {
			f.Close()
			return escaped
		}
	}
	return contained
}

func rawSocket() int {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_RAW, syscall.IPPROTO_ICMP)
	if err == nil {
		syscall.Close(fd)
	}
	return exitIf(err == nil)
}

func writeEtc() int {
	for _, path := range []string{"/etc/aura_escape", "/usr/aura_escape", "/bin/aura_escape"} {
		if f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE, 0o600); err == nil {
			f.Close()
			os.Remove(path)
			return escaped
		}
	}
	return contained
}

func openAny(paths ...string) int {
	for _, path := range paths {
		if f, err := os.OpenFile(path, os.O_RDONLY, 0); err == nil {
			f.Close()
			return escaped
		}
	}
	return contained
}

// workDir is where the probe may write: /work inside the sandbox, a temporary directory in the unconfined control.
func workDir() string {
	if dir := os.Getenv("AURA_WORKDIR"); dir != "" {
		return dir
	}
	return "/work"
}

func mknod() int {
	path := workDir() + "/aura_null"
	if err := syscall.Mknod(path, syscall.S_IFCHR|0o600, int(1<<8|3)); err != nil {
		return contained
	}
	os.Remove(path)
	return escaped
}

// A module load that is permitted fails with a complaint about the (empty) image, not with "not permitted".
func initModule() int {
	_, _, errno := syscall.Syscall(syscall.SYS_INIT_MODULE, 0, 0, uintptr(unsafe.Pointer(&[]byte("\x00")[0])))
	if errno == syscall.EPERM || errno == syscall.ENOSYS || errno == syscall.EACCES {
		return contained
	}
	return escaped
}

func hostPID() int {
	pid, ok := victim()
	if !ok {
		return unusable
	}
	return exitIf(syscall.Kill(pid, 0) == nil)
}

// The host's control-group tree names (init.scope, system.slice, user.slice) are not part of a sandbox's own view.
func hostCgroup() int {
	entries, err := os.ReadDir("/sys/fs/cgroup")
	if err != nil {
		return contained
	}
	for _, entry := range entries {
		switch entry.Name() {
		case "init.scope", "system.slice", "user.slice":
			return escaped
		}
	}
	return contained
}

// Writes into the workspace until three times the disk limit (AURA_DISK_MIB) or a refusal; escaping the limit is writing
// more than the limit.
func diskFill() int {
	limit, err := strconv.Atoi(os.Getenv("AURA_DISK_MIB"))
	if err != nil || limit < 1 {
		return unusable
	}
	chunk := make([]byte, 1<<20)
	written := 0
	for i := 0; i < limit*3; i++ {
		f, err := os.Create(workDir() + "/fill_" + strconv.Itoa(i))
		if err != nil {
			break
		}
		_, werr := f.Write(chunk)
		f.Close()
		if werr != nil {
			break
		}
		written++
	}
	return exitIf(written > limit)
}
