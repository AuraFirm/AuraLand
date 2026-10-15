// aura-judge is the judge node's agent. Subcommands:
//
//	enroll  --control-plane URL --token T --name N --key-file F   (once per node)
//	run     --control-plane URL --node-id ID --key-file F
//
// `run` needs a sandbox. Off Linux there is none (isolate needs Linux and cgroup v2), so it refuses to
// start rather than judge without isolation (run_other.go); on Linux see run_linux.go.
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
	"github.com/AuraFirm/AuraLand/judge/internal/envnode"
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
	case "extract-archive":
		os.Exit(extractArchive(os.Args[2:]))
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
	tier2 := flags.Bool("tier2", false, "declare Tier 2 (environments under gVisor) as well as Tier 1")
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
		Token: *token, Name: *name, PublicKey: sign.Encode(public), AgentVersion: version, Tiers: tiersFor(*tier2),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "enroll:", err)
		return 1
	}
	fmt.Printf("enrolled as %s; start the agent with: aura-judge run --node-id %s --key-file %s\n", out.NodeID, out.NodeID, *keyFile)
	return 0
}

// tiersFor says which tiers a node declares. Tier 2 is only declared by a node that will be started with a runtime for it.
func tiersFor(tier2 bool) []int {
	if tier2 {
		return []int{1, 2}
	}
	return []int{1}
}

// extractArchive is run INSIDE a sandbox by the node (envnode.SandboxExtractor): it unpacks one tar into one directory under the
// extractor's rules and says why in one short line when it refuses. It is not a command for people.
func extractArchive(args []string) int {
	flags := flag.NewFlagSet("extract-archive", flag.ExitOnError)
	archive := flags.String("archive", "", "the tar to unpack")
	into := flags.String("into", "", "the directory to unpack into")
	limitMiB := flags.Int("limit-mib", 1024, "most bytes to unpack, in MiB")
	flags.Parse(args)
	if *archive == "" || *into == "" || *limitMiB < 1 {
		fmt.Fprintln(os.Stderr, "extract-archive needs --archive, --into and a positive --limit-mib")
		return 2
	}
	file, err := os.Open(*archive)
	if err != nil {
		fmt.Println("cannot open the archive")
		return 1
	}
	defer file.Close()
	limits := envnode.DefaultLimits
	limits.Bytes = int64(*limitMiB) << 20
	if err := envnode.Extract(file, *into, limits); err != nil {
		fmt.Println(err)
		return 1
	}
	return 0
}
