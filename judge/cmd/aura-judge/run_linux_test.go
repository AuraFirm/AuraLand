//go:build linux

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/sign"
)

// Goal: the agent reads exactly the key `enroll` writes, and refuses a key anyone else could read.
func TestReadKey(t *testing.T) {
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	write := func(name, text string, mode os.FileMode) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(text), mode); err != nil {
			t.Fatal(err)
		}
		return path
	}
	good := write("good", sign.Encode(private.Seed())+"\n", 0o600)
	key, err := readKey(good)
	if err != nil || !key.Equal(private) {
		t.Fatalf("the key enroll wrote must load: %v", err)
	}
	for name, path := range map[string]string{
		"group readable": write("loose", sign.Encode(private.Seed()), 0o640),
		"not a key":      write("junk", "hello", 0o600),
		"short seed":     write("short", sign.Encode([]byte("abc")), 0o600),
		"missing":        filepath.Join(dir, "none"),
	} {
		if _, err := readKey(path); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
