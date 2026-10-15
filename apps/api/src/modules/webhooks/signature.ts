import { createHmac } from "node:crypto";
import { assert } from "@aura/contracts/assert";

// `t=<unix seconds>,v1=<HMAC-SHA-256 of "t.body" keyed by a secret>`, one v1 per secret in force.
export function signatureHeader(secrets: readonly string[], nowMs: number, body: string): string {
    assert(secrets.length >= 1 && secrets.length <= 2, "one or two secrets sign a delivery");
    const t = Math.floor(nowMs / 1000);
    const signatures = secrets.map((secret) =>
        createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"),
    );
    return [`t=${t}`, ...signatures.map((s) => `v1=${s}`)].join(",");
}
