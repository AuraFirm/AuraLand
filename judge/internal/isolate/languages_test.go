//go:build linux && isolate

package isolate

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

// Every language a participant can submit builds and runs a real program in a real box: reads standard
// input, writes standard output, a syntax error is a compile error with a message, and a run that ends
// badly ends with the right verdict. Run with the escape suite on a node:
//
//	AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/isolate -run TestLanguages
var languageCases = []struct {
	language, sum, broken, crash string
	// An interpreted language has no compile step: its syntax errors are found when it runs, as a runtime error.
	interpreted bool
}{
	{
		language: "cpp",
		sum:      "#include <iostream>\nint main(){long a,b;std::cin>>a>>b;std::cout<<a+b<<\"\\n\";}\n",
		broken:   "int main( { return 0 }\n",
		crash:    "int main(){ int *p = 0; return *p; }\n",
	},
	{
		language: "c",
		sum:      "#include <stdio.h>\nint main(void){long a,b;if(scanf(\"%ld %ld\",&a,&b)!=2)return 1;printf(\"%ld\\n\",a+b);return 0;}\n",
		broken:   "int main( { return 0 }\n",
		crash:    "int main(void){ volatile int *p = 0; return *p; }\n",
	},
	{
		language: "java",
		sum:      "import java.util.Scanner;\npublic class Main { public static void main(String[] x) { Scanner s = new Scanner(System.in); long a = s.nextLong(), b = s.nextLong(); System.out.println(a + b); } }\n",
		broken:   "public class Main { public static void main(String[] x) { int y = ; } }\n",
		crash:    "public class Main { public static void main(String[] x) { int[] a = new int[1]; a[2] = 1; } }\n",
	},
	{
		language:    "python3",
		sum:         "a, b = map(int, input().split())\nprint(a + b)\n",
		broken:      "def main(:\n    pass\n",
		crash:       "raise SystemExit(7)\n",
		interpreted: true,
	},
}

func TestLanguagesBuildAndRun(t *testing.T) {
	binary := os.Getenv("AURA_ISOLATE_BIN")
	if binary == "" {
		t.Skip("AURA_ISOLATE_BIN is not set")
	}
	box, err := New(binary, 2)
	if err != nil {
		t.Fatal(err)
	}
	compileLimits := sandbox.Limits{CPUMS: 30000, WallMS: 60000, MemoryKiB: 1 << 20, OutputKiB: 64}
	runLimits := sandbox.Limits{CPUMS: 2000, WallMS: 6000, MemoryKiB: 262144, OutputKiB: 64}
	for _, c := range languageCases {
		t.Run(c.language, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			defer cancel()
			built, err := box.Compile(ctx, c.language, c.sum, compileLimits)
			if err != nil || !built.OK {
				t.Fatalf("the sum program must build: %v %s", err, built.Message)
			}
			defer built.Program.Release()
			run, err := box.Run(ctx, built.Program, []byte("40 2\n"), runLimits)
			if err != nil || run.Verdict != "OK" || strings.TrimSpace(string(run.Stdout)) != "42" {
				t.Fatalf("sum: %+v %v", run, err)
			}
			t.Logf("%s sum: cpu=%dms wall=%dms mem=%dKiB", c.language, run.CPUMS, run.WallMS, run.MemoryKiB)

			bad, err := box.Compile(ctx, c.language, c.broken, compileLimits)
			if c.interpreted {
				if err != nil || !bad.OK {
					t.Fatalf("an interpreted language builds anything: %+v %v", bad, err)
				}
				defer bad.Program.Release()
				found, err := box.Run(ctx, bad.Program, nil, runLimits)
				if err != nil || found.Verdict != "RTE" {
					t.Fatalf("a syntax error found at run time is a runtime error: %+v %v", found, err)
				}
			} else if err != nil || bad.OK || bad.Message == "" {
				t.Fatalf("a syntax error is a compile error with a message: %+v %v", bad, err)
			}
			crashed, err := box.Compile(ctx, c.language, c.crash, compileLimits)
			if err != nil || !crashed.OK {
				t.Fatalf("the crash program must build: %v %s", err, crashed.Message)
			}
			defer crashed.Program.Release()
			end, err := box.Run(ctx, crashed.Program, nil, runLimits)
			if err != nil || end.Verdict != "RTE" {
				t.Fatalf("a crash is a runtime error: %+v %v", end, err)
			}
		})
	}
}
