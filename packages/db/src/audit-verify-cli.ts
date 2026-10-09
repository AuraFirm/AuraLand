import { verifyAuditChain } from "./audit.ts";
import { createDatabase } from "./client.ts";

// Usage: pnpm audit:verify [--expect-head=<seq>:<hash>]
// Exits 1 when the chain does not verify. Keep the printed head somewhere outside the database
// (object storage with object lock, later) and pass it back with --expect-head to catch truncation.

const url = process.env["AURA_DATABASE_URL"];
if (url === undefined) throw new Error("AURA_DATABASE_URL is required to verify the audit log");
const argument = process.argv.find((a) => a.startsWith("--expect-head="));
const [seq, hash] =
    argument === undefined ? [] : argument.slice("--expect-head=".length).split(":");
const expectedHead = seq !== undefined && hash !== undefined ? { seq, hash } : undefined;

const database = createDatabase(url, 1);
try {
    const result = await verifyAuditChain(
        database.sql,
        expectedHead === undefined ? {} : { expectedHead },
    );
    if (result.ok) {
        const head = result.head === null ? "empty" : `${result.head.seq}:${result.head.hash}`;
        process.stdout.write(`audit chain ok, head ${head}\n`);
    } else {
        process.stderr.write(`audit chain FAILED: ${JSON.stringify(result)}\n`);
        process.exitCode = 1;
    }
} finally {
    await database.close(5);
}
