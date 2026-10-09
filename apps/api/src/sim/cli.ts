import { parseArgs } from "node:util";
import { formatFailure, runSeeds } from "./runner.ts";
import { SCENARIOS } from "./scenarios.ts";

// Usage: pnpm test:sim [--scenario=<name>] [--seed=<n>] [--seeds=<count>]
// A failure prints SEED=... so `pnpm test:sim --scenario=<name> --seed=<n>` reproduces it exactly.

const { values } = parseArgs({
    options: {
        scenario: { type: "string", default: "all" },
        seed: { type: "string", default: "0" },
        seeds: { type: "string", default: "500" },
    },
    strict: true,
});

const firstSeed = Number(values.seed);
const seedCount = values.seed !== "0" && values.seeds === "500" ? 1 : Number(values.seeds);
const selected = SCENARIOS.filter((s) => values.scenario === "all" || s.name === values.scenario);
if (selected.length === 0) {
    process.stderr.write(`No scenario named ${values.scenario}\n`);
    process.exit(2);
}

let failed = false;
for (const scenario of selected) {
    const failures = runSeeds(scenario, firstSeed, seedCount);
    process.stdout.write(
        `${scenario.name}: ${seedCount - failures.length}/${seedCount} seeds ok\n`,
    );
    for (const failure of failures.slice(0, 5)) {
        process.stderr.write(`${formatFailure(failure)}\n`);
        failed = true;
    }
}
process.exit(failed ? 1 : 0);
