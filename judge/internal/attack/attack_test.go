package attack

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Goal: every attacker exists, in the fixed order, and sample_lookup answers exactly the samples. The
// programs are run here with the host's python3 only when it is available: this is a test of the text
// we generate, on data we wrote, never of anything untrusted (the sandbox runs them for real).
func TestEveryNamedAttackerHasASource(t *testing.T) {
	programs, err := Programs(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(programs) != len(Names) {
		t.Fatalf("%d programs for %d names", len(programs), len(Names))
	}
	for i, program := range programs {
		if program.Name != Names[i] || strings.TrimSpace(program.Source) == "" {
			t.Errorf("attacker %d: %+v", i, program)
		}
	}
}

func run(t *testing.T, source, stdin string) string {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	command := exec.Command(python, "-S", "-c", source)
	command.Stdin = strings.NewReader(stdin)
	out, err := command.Output()
	if err != nil {
		t.Fatalf("%v\n%s", err, source)
	}
	return string(out)
}

func TestAttackersBehaveAsNamed(t *testing.T) {
	programs, _ := Programs([]Sample{{Input: []byte("1 2\n"), Answer: []byte("3\n")}, {Input: []byte("a \"quoted\" '''\n"), Answer: []byte("odd\n")}})
	by := map[string]string{}
	for _, p := range programs {
		by[p.Name] = p.Source
	}
	cases := []struct{ name, stdin, want string }{
		{"sample_lookup", "1 2\n", "3\n"},
		{"sample_lookup", "a \"quoted\" '''\n", "odd\n"},
		{"sample_lookup", "5 6\n", ""},
		{"echo_input", "x y\n", "x y\n"},
		{"first_token", "7 8\n", "7\n"},
		{"first_token", "", "\n"},
		{"token_count", "a b c\n", "3\n"},
		{"sum_of_integers", "1 2 -4 x 10\n", "9\n"},
		{"constant_0", "anything", "0\n"},
		{"constant_yes", "", "YES\n"},
		{"empty_output", "anything", ""},
	}
	for _, c := range cases {
		if got := run(t, by[c.name], c.stdin); got != c.want {
			t.Errorf("%s(%q) = %q, want %q", c.name, c.stdin, got, c.want)
		}
	}
}

func TestSampleLookupIsBounded(t *testing.T) {
	big := make([]byte, SampleBytesMax)
	source, err := sampleLookup([]Sample{{Input: big, Answer: big}})
	if err != nil {
		t.Fatal(err)
	}
	if len(source) > 8*1024 {
		t.Errorf("a sample over the cap must not be embedded: %d bytes", len(source))
	}
}

// The control plane requires exactly these names (packages/contracts/src/validation.ts). The shared
// fixture is checked by the TypeScript side against that list, so comparing it here ties the two.
func TestNamesMatchTheSharedFixture(t *testing.T) {
	raw, err := os.ReadFile("../../fixtures/validation-complete-request.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Result struct {
			Attackers []struct{ Name string } `json:"attackers"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Result.Attackers) != len(Names) {
		t.Fatalf("fixture has %d attackers, Names has %d", len(fixture.Result.Attackers), len(Names))
	}
	for i, attacker := range fixture.Result.Attackers {
		if attacker.Name != Names[i] {
			t.Errorf("attacker %d: fixture %q, Names %q", i, attacker.Name, Names[i])
		}
	}
}
