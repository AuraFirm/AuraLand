import { parseArgs } from "node:util";
import { fuzzValidator } from "./fuzz.ts";

// Usage: node packages/bundle/src/fuzz-cli.ts [--seed=<n>] [--iterations=<count>]
// Exits non-zero, printing the seed and iteration, if the validator ever throws.
const { values } = parseArgs({
    options: {
        seed: { type: "string", default: "1" },
        iterations: { type: "string", default: "20000" },
    },
    strict: true,
});
const report = fuzzValidator(Number(values.seed), Number(values.iterations));
process.stdout.write(`${JSON.stringify(report)}\n`);
