import { execFileSync } from "node:child_process";

// Runs the Semgrep rules in tools/semgrep: first the rules' own annotated tests, then a scan of the
// code. The image is pinned by digest (Semgrep 1.179.0, published 2026-10-02) so local runs and CI
// use the identical scanner. Needs Docker. The repository is mounted read-only.
const IMAGE =
    "semgrep/semgrep@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b";

const COMMON = ["--metrics=off", "--disable-version-check"];
const STEPS: ReadonlyArray<readonly string[]> = [
    ["semgrep", "--test", ...COMMON, "tools/semgrep"],
    [
        ...[
            "semgrep",
            "scan",
            "--config",
            "tools/semgrep",
            "--exclude",
            "tools/semgrep",
            "--error",
        ],
        ...COMMON,
        ...["apps", "packages", "tools"],
    ],
];

for (const step of STEPS) {
    const args = [
        "run",
        "--rm",
        "--volume",
        `${process.cwd()}:/src:ro`,
        "--workdir",
        "/src",
        IMAGE,
    ];
    try {
        execFileSync("docker", [...args, ...step], { stdio: "inherit" });
    } catch {
        process.stderr.write(`semgrep step failed: ${step.slice(0, 2).join(" ")}\n`);
        process.exit(1);
    }
}
process.stdout.write("semgrep: rule tests and scan passed\n");
