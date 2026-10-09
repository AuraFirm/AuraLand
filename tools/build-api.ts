import { build } from "esbuild";

// Bundles the API into one file with all dependencies inlined. The production image then needs no
// node_modules at all, which removes a whole class of runtime supply-chain exposure. Node strips
// types only outside node_modules, so shipping workspace TypeScript sources is not an option.
// Run from apps/api (the `build` script's working directory).

await build({
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.js",
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: true,
    minify: false,
    logLevel: "info",
    // CommonJS dependencies (pino) call require(); this shim keeps them working in an ES module.
    banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
});
