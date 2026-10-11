package isolate

import (
	"fmt"
	"strconv"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

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
func RunArgs(boxID int, limits sandbox.Limits, processes int, metaPath, stdin, stdout, stderr string, environment, command []string) ([]string, error) {
	if boxID < 0 || boxID > BoxIDMax {
		return nil, fmt.Errorf("box id %d out of range", boxID)
	}
	if limits.CPUMS <= 0 || limits.WallMS <= 0 || limits.MemoryKiB <= 0 || limits.OutputKiB <= 0 || processes <= 0 {
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
		"--fsize=" + strconv.Itoa(limits.OutputKiB),
		"--stack=" + strconv.Itoa(limits.MemoryKiB),
		"--meta=" + metaPath,
		"--stdin=" + stdin,
		"--stdout=" + stdout,
		"--stderr=" + stderr,
		"--silent",
	}
	for _, entry := range environment {
		args = append(args, "--env="+entry)
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
