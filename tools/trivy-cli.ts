import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Scans container images (vulnerabilities and secrets) and the Dockerfiles (misconfiguration) with
// Trivy. The scanner is pinned by digest (Trivy 0.75.0, published 2026-10-01), so local runs and CI
// agree. Pulled from GitHub's registry, not Docker Hub, to avoid its anonymous pull limit (ADR 0010). Usage: node tools/trivy-cli.ts <image> [<image> ...]  (images must already be built).
// Findings of HIGH or CRITICAL severity that have a fix available fail the run. Unfixed ones are
// ignored because nothing can be done about them yet; Dependabot and rebuilds cover them later.
const TRIVY =
    "ghcr.io/aquasecurity/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa";
const SEVERITY = "HIGH,CRITICAL";
// A directory under the home folder, because Colima shares only the home folder with its VM.
const WORK = join(homedir(), ".cache", "aura-trivy");

function trivy(mounts: string[], args: string[]): void {
    const volumes = [...mounts, "trivy-cache:/root/.cache"].flatMap((m) => ["--volume", m]);
    execFileSync("docker", ["run", "--rm", ...volumes, TRIVY, ...args], { stdio: "inherit" });
}

function scanImage(image: string, index: number): void {
    const tar = `image-${index}.tar`;
    execFileSync("docker", ["save", image, "--output", join(WORK, tar)], { stdio: "inherit" });
    trivy(
        [`${WORK}:/in:ro`],
        [
            ...["image", "--input", `/in/${tar}`, "--severity", SEVERITY, "--ignore-unfixed"],
            ...["--scanners", "vuln,secret", "--exit-code", "1", "--no-progress"],
        ],
    );
}

const images = process.argv.slice(2);
if (images.length === 0) {
    process.stderr.write("usage: node tools/trivy-cli.ts <image> [<image> ...]\n");
    process.exit(2);
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
try {
    images.forEach(scanImage);
    trivy(
        [`${process.cwd()}:/src:ro`],
        [...["config", "--severity", SEVERITY, "--exit-code", "1"], "/src/apps"],
    );
} catch {
    process.stderr.write("trivy: findings or a scanner error, see the output above\n");
    process.exit(1);
} finally {
    rmSync(WORK, { recursive: true, force: true });
}
process.stdout.write("trivy: images and Dockerfiles passed\n");
