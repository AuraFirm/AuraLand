//go:build linux && isolate

package bundles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/isolate"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// The opener against the real sandbox, on a judge node or a Linux VM with isolate (cutlist F31):
//
//	AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/bundles
//
// It needs the pinned Node under /opt/aura/node and the built opener (node tools/build-opener.ts).
// The corpus files are the same ones the TypeScript validator is tested with, so a bundle that the
// validator answers one way must be answered the same way here, from inside a box.
func realOpener(t *testing.T, packed []byte) (*Opener, wire.LeasedJob) {
	binary := os.Getenv("AURA_ISOLATE_BIN")
	if binary == "" {
		t.Skip("AURA_ISOLATE_BIN is not set")
	}
	script, err := os.ReadFile("../../../packages/bundle/dist/open-bundle.cjs")
	if err != nil {
		t.Fatal(err)
	}
	box, err := isolate.New(binary, 1)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(packed)
	job := wire.LeasedJob{Task: wire.Task{Bundle: wire.Bundle{SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(packed))}}}
	fetch := func(context.Context, wire.LeasedJob) ([]byte, error) { return packed, nil }
	return &Opener{Box: box, Fetch: fetch, Script: string(script)}, job
}

func corpus(t *testing.T, name string) []byte {
	data, err := os.ReadFile("../../../packages/bundle/corpus/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRealBoxOpensAGoodBundle(t *testing.T) {
	opener, job := realOpener(t, corpus(t, "golden-rich.tar.zst"))
	files, err := opener.OpenFiles(context.Background(), job)
	if err != nil {
		t.Fatal(err)
	}
	if data, ok := files.Get("tests/002.in"); !ok || string(data) != "40 2\n" {
		t.Fatalf("got %q %v", data, ok)
	}
	if _, ok := files.Get("solutions/reference.cpp"); !ok {
		t.Fatal("the reference solution must come out")
	}
	t.Logf("opened %v", files.Paths())
}

func TestRealBoxRefusesWhatTheValidatorRefuses(t *testing.T) {
	for name, code := range map[string]string{
		"layout-solution-badname.tar.zst":       "unexpected_file",
		"ratio-bomb-300mib-of-zeros.tar.zst":    "compression_ratio",
		"tar-golden-with-symlink-first.tar.zst": "unsupported_entry",
		"layout-no-statement.tar.zst":           "missing_file",
	} {
		opener, job := realOpener(t, corpus(t, name))
		_, err := opener.OpenFiles(context.Background(), job)
		var refused *Refused
		if !errors.As(err, &refused) || refused.Code != code {
			t.Errorf("%s: got %v want refusal %s", name, err, code)
		}
	}
}
