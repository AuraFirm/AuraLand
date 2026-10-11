import { writeFileSync } from "node:fs";
import { SIGNATURE_FIXTURE_PATH, signatureFixture } from "./http-judge-support.ts";

// Usage: node apps/api/src/judge-fixtures-cli.ts
// Rewrites judge/fixtures/signature.json, the request-signing vector the Go agent is tested against.
writeFileSync(SIGNATURE_FIXTURE_PATH, `${JSON.stringify(signatureFixture(), null, 4)}\n`);
process.stdout.write("wrote judge/fixtures/signature.json\n");
