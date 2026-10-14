import { build } from "esbuild";

// Builds the programs a judge node runs in a box into one dependency-free file each: the bundle opener
// (packages/bundle/src/open-cli.ts) and the delivery watermark rewriter (rewrite-cli.ts). The box holds
// a pinned Node and nothing else, so everything the validator needs (zod, the contracts) is inlined,
// and the node operator installs plain files.
// Usage: node tools/build-opener.ts
const PROGRAMS = [
    { entry: "packages/bundle/src/open-cli.ts", out: "packages/bundle/dist/open-bundle.cjs" },
    { entry: "packages/bundle/src/rewrite-cli.ts", out: "packages/bundle/dist/rewrite-bundle.cjs" },
] as const;

for (const program of PROGRAMS) {
    await build({
        entryPoints: [program.entry],
        outfile: program.out,
        bundle: true,
        platform: "node",
        target: "node24",
        format: "cjs",
        minify: false,
        logLevel: "warning",
    });
    process.stdout.write(`wrote ${program.out}\n`);
}
