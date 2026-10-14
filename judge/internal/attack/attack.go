// Package attack builds the platform's own cheap "solutions": programs that know nothing about the
// problem and try to pass anyway. If a task's tests accept one of them, the tests check too little to
// tell a capable solver from a lazy one. They are Python text only; the sandbox runs them
// (internal/validate), like every other untrusted-looking program.
package attack

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// Program is one attacker.
type Program struct {
	Name   string
	Source string
}

// Sample is a test whose input and answer are public (it is in the statement).
type Sample struct{ Input, Answer []byte }

// Names is the fixed set every validation must report, in order. The control plane requires exactly
// these (packages/contracts/src/validation.ts VALIDATION_ATTACKERS), so a node cannot skip the hard ones.
var Names = []string{
	"sample_lookup", "echo_input", "first_token", "token_count", "sum_of_integers",
	"constant_0", "constant_1", "constant_yes", "constant_no", "empty_output",
}

// SampleBytesMax bounds what sample_lookup embeds: a program the size of a bundle would be a test of
// the sandbox, not of the task. Samples beyond it are left out (the attacker then does worse, which
// can only make a task look stronger, so the cap is reported in the program's name, not hidden).
const SampleBytesMax = 256 * 1024

const header = "import sys, re\ndata = sys.stdin.read()\ntokens = data.split()\n"

var fixed = map[string]string{
	"echo_input":      header + "sys.stdout.write(data)\n",
	"first_token":     header + "print(tokens[0] if tokens else '')\n",
	"token_count":     header + "print(len(tokens))\n",
	"sum_of_integers": header + "print(sum(int(t) for t in tokens if re.fullmatch(r'-?[0-9]{1,18}', t)))\n",
	"constant_0":      "print(0)\n",
	"constant_1":      "print(1)\n",
	"constant_yes":    "print('YES')\n",
	"constant_no":     "print('NO')\n",
	"empty_output":    "pass\n",
}

// Programs returns every attacker, in the order of Names.
func Programs(samples []Sample) ([]Program, error) {
	programs := make([]Program, 0, len(Names))
	for _, name := range Names {
		if name == "sample_lookup" {
			source, err := sampleLookup(samples)
			if err != nil {
				return nil, err
			}
			programs = append(programs, Program{Name: name, Source: source})
			continue
		}
		source, ok := fixed[name]
		if !ok {
			return nil, fmt.Errorf("no source for attacker %q", name)
		}
		programs = append(programs, Program{Name: name, Source: source})
	}
	return programs, nil
}

// sampleLookup answers the public samples from a table and nothing else. The table travels as base64
// of JSON so no sample text can break out of the program's quoting.
func sampleLookup(samples []Sample) (string, error) {
	table := map[string]string{}
	total := 0
	for _, sample := range samples {
		total += len(sample.Input) + len(sample.Answer)
		if total > SampleBytesMax {
			break
		}
		table[string(sample.Input)] = string(sample.Answer)
	}
	encoded, err := json.Marshal(table)
	if err != nil {
		return "", err
	}
	text := base64.StdEncoding.EncodeToString(encoded)
	return fmt.Sprintf("import sys, json, base64\ntable = json.loads(base64.b64decode('%s').decode())\nsys.stdout.write(table.get(sys.stdin.read(), ''))\n", text), nil
}
