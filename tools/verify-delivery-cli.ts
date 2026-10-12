import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { verifyDelivery } from "./verify-delivery.ts";

// Usage: node tools/verify-delivery-cli.ts --manifest <file> --bundles <directory> [--manifest-sha256 <hex>]
const { values } = parseArgs({
    options: {
        manifest: { type: "string" },
        bundles: { type: "string" },
        "manifest-sha256": { type: "string" },
    },
    strict: true,
});
if (values.manifest === undefined || values.bundles === undefined) {
    process.stderr.write(
        "usage: --manifest <file> --bundles <directory> [--manifest-sha256 <hex>]\n",
    );
    process.exit(2);
}
const directory = values.bundles;
const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, bytes: readFileSync(join(directory, entry.name)) }));
const result = verifyDelivery(
    readFileSync(values.manifest, "utf8"),
    values["manifest-sha256"] ?? null,
    files,
);
if (result.problems.length > 0) {
    for (const problem of result.problems) process.stderr.write(`FAIL: ${problem}\n`);
    process.exit(1);
}
process.stdout.write(`OK: ${result.itemCount} item(s) match the manifest\n`);
