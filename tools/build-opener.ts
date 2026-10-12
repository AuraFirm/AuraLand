import { build } from "esbuild";

// Builds the program a judge node runs in a box to open a bundle (packages/bundle/src/open-cli.ts)
// into one dependency-free file. The box holds a pinned Node and nothing else, so everything the
// validator needs (zod, the contracts) is inlined, and the node operator installs one file.
// Usage: node tools/build-opener.ts
await build({
    entryPoints: ["packages/bundle/src/open-cli.ts"],
    outfile: "packages/bundle/dist/open-bundle.cjs",
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    minify: false,
    logLevel: "warning",
});
process.stdout.write("wrote packages/bundle/dist/open-bundle.cjs\n");
