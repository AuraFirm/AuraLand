package isolate

import "github.com/AuraFirm/AuraLand/judge/internal/sandbox"

// Verdict maps isolate's report to the sandbox's view of one run (docs/kit/07 section 4.3). Order
// matters and is deliberate: the sandbox's own failure comes first, because anything it says after an
// internal error is unreliable; memory comes before the generic signal, because the OOM killer ends a
// program with SIGKILL and that must not look like a crash; time before signals for the same reason
// (isolate kills a program that used up its time).
func Verdict(meta Meta, limits sandbox.Limits, outputBytes int) string {
	switch {
	case meta.Status == "XX":
		return "SE"
	case meta.CgOOMKilled || (limits.MemoryKiB > 0 && meta.CgMemKiB > limits.MemoryKiB):
		return "MLE"
	case meta.Status == "TO" || (limits.CPUMS > 0 && int(meta.CPUSeconds*1000) > limits.CPUMS):
		return "TLE"
	case limits.OutputKiB > 0 && outputBytes > limits.OutputKiB*1024:
		return "OLE"
	case meta.Status == "SG" || meta.Status == "RE" || meta.Killed:
		return "RTE"
	case meta.Status == "":
		return "OK"
	default:
		// A status we have never seen says nothing about the code; treat it as the sandbox's failure.
		return "SE"
	}
}
