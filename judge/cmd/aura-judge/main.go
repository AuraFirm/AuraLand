// aura-judge is the judge node's agent. Subcommands:
//
//	enroll  --control-plane URL --token T --name N --key-file F   (once per node)
//	run     --control-plane URL --node-id ID --key-file F
//
// `run` needs a sandbox. This build has none for the current platform (isolate needs Linux and cgroup
// v2), so it refuses to start rather than judge without isolation.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/client"
	"github.com/AuraFirm/AuraLand/judge/internal/sign"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: aura-judge enroll|run [flags]")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "enroll":
		os.Exit(enroll(os.Args[2:]))
	case "run":
		os.Exit(run(os.Args[2:]))
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}

func enroll(args []string) int {
	flags := flag.NewFlagSet("enroll", flag.ExitOnError)
	plane := flags.String("control-plane", "", "control plane address ending in /api/judge/v1")
	token := flags.String("token", "", "single-use enrollment token")
	name := flags.String("name", "", "node name")
	keyFile := flags.String("key-file", "", "where to write the node's private key (must not exist)")
	flags.Parse(args)
	if *plane == "" || *token == "" || *name == "" || *keyFile == "" {
		fmt.Fprintln(os.Stderr, "enroll needs --control-plane, --token, --name and --key-file")
		return 2
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// The key is written first and exclusively: a failed enrollment leaves a key file the operator
	// can see, and an existing key is never overwritten.
	file, err := os.OpenFile(*keyFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "key file:", err)
		return 1
	}
	if _, err := file.WriteString(sign.Encode(private.Seed()) + "\n"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	file.Close()
	anonymous, err := client.New(*plane, "", private, &http.Client{Timeout: 30 * time.Second}, time.Now)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	out, err := anonymous.Enroll(context.Background(), wire.EnrollRequest{
		Token: *token, Name: *name, PublicKey: sign.Encode(public), AgentVersion: version, Tiers: []int{1},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "enroll:", err)
		return 1
	}
	fmt.Printf("enrolled as %s; start the agent with: aura-judge run --node-id %s --key-file %s\n", out.NodeID, out.NodeID, *keyFile)
	return 0
}

func run(args []string) int {
	flags := flag.NewFlagSet("run", flag.ExitOnError)
	flags.String("control-plane", "", "control plane address ending in /api/judge/v1")
	flags.String("node-id", "", "node id printed by enroll")
	flags.String("key-file", "", "the node's private key file")
	flags.Parse(args)
	fmt.Fprintln(os.Stderr, "aura-judge: no sandbox is available in this build. Judging without isolation is refused. "+
		"Run on a Linux judge node with the isolate driver (docs/stages/stage-3-plan.md section 2).")
	return 2
}
