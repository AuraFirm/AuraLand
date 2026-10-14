package mutate

import (
	"strings"
	"testing"
)

// Goal: mutants are one change each, deterministic, and never touch comments, strings or I/O
// operators. Method: small programs where the expected mutants can be listed by hand.
func TestOneChangePerMutantAndTheLineIsRight(t *testing.T) {
	source := "int main(){\n  int a = 2 + 3;\n  return a;\n}\n"
	mutants, err := Generate("cpp", source, MaxPerSolution)
	if err != nil {
		t.Fatal(err)
	}
	ops := map[string]string{}
	for _, m := range mutants {
		ops[m.Operator] = m.Source
		if m.Source == source {
			t.Errorf("%s changed nothing", m.Operator)
		}
	}
	if got := ops["+ to -"]; got != "int main(){\n  int a = 2 - 3;\n  return a;\n}\n" {
		t.Errorf("+ to -: %q", got)
	}
	if _, ok := ops["2 to 3"]; !ok {
		t.Errorf("a literal is changed by one: %v", ops)
	}
	for _, m := range mutants {
		if m.Operator == "+ to -" && m.Line != 2 {
			t.Errorf("line %d", m.Line)
		}
	}
}

func TestCommentsStringsPreprocessorAndIOAreLeftAlone(t *testing.T) {
	source := "#include <iostream>\n// a + b < c\nint main(){ std::cout << \"1 + 2\" << 'x'; /* 3 + 4 */ std::cin >> n; p->q; i++; x += 1; }\n"
	mutants, _ := Generate("cpp", source, MaxPerSolution)
	for _, m := range mutants {
		if strings.Contains(m.Operator, "+ to") || strings.Contains(m.Operator, "< to") || strings.Contains(m.Operator, "> to") {
			t.Errorf("mutated something that is not logic: %s at line %d", m.Operator, m.Line)
		}
	}
	if len(mutants) != 1 || mutants[0].Operator != "1 to 2" {
		t.Errorf("only the literal after += is logic here: %+v", mutants)
	}
}

func TestPythonWordsAndComments(t *testing.T) {
	source := "a, b = map(int, input().split())\nif a > 0 and b >= 1:  # a < b\n    print(a * b)\n"
	mutants, err := Generate("python3", source, MaxPerSolution)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, m := range mutants {
		seen[m.Operator] = true
	}
	for _, want := range []string{"and to or", "> to >=", ">= to >", "* to +", "0 to 1", "1 to 2"} {
		if !seen[want] {
			t.Errorf("missing %q in %v", want, seen)
		}
	}
	if seen["< to <="] {
		t.Error("the comment was mutated")
	}
}

func TestCappedEvenlyAndDeterministically(t *testing.T) {
	source := strings.Repeat("x = x + 1\n", 100)
	first, _ := Generate("python3", source, 10)
	second, _ := Generate("python3", source, 10)
	if len(first) != 10 || len(second) != 10 {
		t.Fatalf("cap: %d %d", len(first), len(second))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("not deterministic at %d", i)
		}
	}
	if first[0].Line != 1 || first[9].Line < 80 {
		t.Errorf("mutants should cover the whole program: first line %d, last line %d", first[0].Line, first[9].Line)
	}
}

func TestRefusesWhatItCannotDo(t *testing.T) {
	if _, err := Generate("rust", "fn main(){}", 5); err == nil {
		t.Error("an unknown language must be refused")
	}
	if _, err := Generate("cpp", "int main(){}", 0); err == nil {
		t.Error("a zero cap must be refused")
	}
	if mutants, err := Generate("cpp", "", 5); err != nil || len(mutants) != 0 {
		t.Errorf("an empty program has no mutants: %v %v", mutants, err)
	}
}
