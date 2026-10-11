package sign

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type fixture struct {
	SeedHex     string `json:"seed_hex"`
	PublicKey   string `json:"public_key"`
	Method      string `json:"method"`
	Target      string `json:"target"`
	TimestampMS int64  `json:"timestampMs"`
	Nonce       string `json:"nonce"`
	Body        string `json:"body"`
	Canonical   string `json:"canonical"`
	Signature   string `json:"signature"`
}

// The vector is written by the TypeScript side (judge-fixtures-cli.ts). Ed25519 is deterministic, so
// this agent must produce byte-for-byte the same canonical text, public key and signature.
func TestAgentSignsExactlyWhatTheControlPlaneVerifies(t *testing.T) {
	raw, err := os.ReadFile("../../fixtures/signature.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	seed, err := hex.DecodeString(f.SeedHex)
	if err != nil {
		t.Fatal(err)
	}
	key := ed25519.NewKeyFromSeed(seed)
	if got := Encode(key.Public().(ed25519.PublicKey)); got != f.PublicKey {
		t.Fatalf("public key %s, want %s", got, f.PublicKey)
	}
	if got := Canonical(f.Method, f.Target, f.TimestampMS, f.Nonce, []byte(f.Body)); got != f.Canonical {
		t.Fatalf("canonical text differs:\n%q\n%q", got, f.Canonical)
	}
	if got := Sign(key, f.Method, f.Target, f.TimestampMS, f.Nonce, []byte(f.Body)); got != f.Signature {
		t.Fatalf("signature %s, want %s", got, f.Signature)
	}
}

func TestEveryPartOfTheRequestChangesTheText(t *testing.T) {
	base := Canonical("POST", "/a?x=1", 100, "n", []byte("b"))
	changed := []string{
		Canonical("GET", "/a?x=1", 100, "n", []byte("b")),
		Canonical("POST", "/a?x=2", 100, "n", []byte("b")),
		Canonical("POST", "/a?x=1", 101, "n", []byte("b")),
		Canonical("POST", "/a?x=1", 100, "m", []byte("b")),
		Canonical("POST", "/a?x=1", 100, "n", []byte("c")),
	}
	for i, text := range changed {
		if text == base {
			t.Fatalf("change %d did not alter the canonical text", i)
		}
	}
	if Canonical("post", "/a?x=1", 100, "n", []byte("b")) != base {
		t.Fatal("the method is case-insensitive")
	}
}
