//go:build !linux

package main

import (
	"fmt"
	"os"
)

func run(_ []string) int {
	fmt.Fprintln(os.Stderr, "aura-judge: no sandbox is available on this platform. Judging without isolation is refused. "+
		"Run on a Linux judge node with the isolate driver (judge/node/README.md).")
	return 2
}
