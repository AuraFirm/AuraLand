package isolate

import (
	"fmt"
	"strconv"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

// CompileFileKiBMax bounds the files a compiler may write: a statically linked C++ program is a few
// megabytes, and 32 MiB leaves room without letting a compiler fill the disk.
const CompileFileKiBMax = 32 * 1024

// BoxIDMax bounds the box ids this agent hands out (isolate's default config allows 1000 boxes).
const BoxIDMax = 999

// Fixed isolation flags. Nothing here is optional: there is deliberately no flag, parameter or
// environment variable that turns the cgroup, the network namespace or the resource limits off.
//
//	--cg                    use a cgroup (v2) for memory and CPU accounting and limits
//	--cg-mem=<kib>          hard memory limit of the cgroup (swap is off in the node baseline)
//	--processes=<n>         bound on processes and threads
//	--time/--wall-time      CPU and wall limits; --extra-time lets isolate report the real overrun
//	--fsize/--stack         largest file the program may write, stack size
//	--no-default-dirs is NOT used: the default read-only system directories are what a compiler needs;
//	the network namespace is isolate's default (no --share-net, ever).
//
// fileKiB is the largest file the program may write. A run passes its output limit; a compile passes
// CompileFileKiBMax, because a linker writes the whole program and a 64 KiB cap would kill it. An
// empty stderr merges standard error into standard output (compiler diagnostics are on stderr).
func RunArgs(boxID int, limits sandbox.Limits, fileKiB, processes int, metaPath, stdin, stdout, stderr string, environment, directories, command []string) ([]string, error) {
	if boxID < 0 || boxID > BoxIDMax {
		return nil, fmt.Errorf("box id %d out of range", boxID)
	}
	if limits.CPUMS <= 0 || limits.WallMS <= 0 || limits.MemoryKiB <= 0 || limits.OutputKiB <= 0 || fileKiB <= 0 || processes <= 0 {
		return nil, fmt.Errorf("every limit must be positive: %+v processes=%d", limits, processes)
	}
	if len(command) == 0 {
		return nil, fmt.Errorf("no command to run")
	}
	args := []string{
		"--cg",
		"--box-id=" + strconv.Itoa(boxID),
		"--cg-mem=" + strconv.Itoa(limits.MemoryKiB),
		"--processes=" + strconv.Itoa(processes),
		"--time=" + seconds(limits.CPUMS),
		"--wall-time=" + seconds(limits.WallMS),
		"--extra-time=0.5",
		"--fsize=" + strconv.Itoa(fileKiB),
		"--stack=" + strconv.Itoa(limits.MemoryKiB),
		"--meta=" + metaPath,
		"--stdin=" + stdin,
		"--stdout=" + stdout,
		"--silent",
	}
	if stderr == "" {
		args = append(args, "--stderr-to-stdout")
	} else {
		args = append(args, "--stderr="+stderr)
	}
	for _, entry := range environment {
		args = append(args, "--env="+entry)
	}
	for _, directory := range directories {
		// Read-only by isolate's default: no ":rw" is ever added, so a profile cannot ask for a writable mount.
		args = append(args, "--dir="+directory)
	}
	args = append(args, "--run", "--")
	return append(args, command...), nil
}

func seconds(milliseconds int) string {
	return strconv.FormatFloat(float64(milliseconds)/1000, 'f', 3, 64)
}

// InitArgs and CleanupArgs create and remove a box.
func InitArgs(boxID int) []string {
	return []string{"--cg", "--box-id=" + strconv.Itoa(boxID), "--init"}
}
func CleanupArgs(boxID int) []string {
	return []string{"--cg", "--box-id=" + strconv.Itoa(boxID), "--cleanup"}
}
