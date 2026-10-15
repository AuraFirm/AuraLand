// Goal: the JSON fixtures shared with the Go agent (judge/fixtures) are valid under the control plane's
// strict contracts. The Go tests decode the very same files with unknown fields refused, so a field
// added on one side only fails one of the two suites.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    enrollRequestSchema,
    envCompleteRequestSchema,
    envLeaseResponseSchema,
    jobCompleteRequestSchema,
    jobFailRequestSchema,
    leaseResponseSchema,
    nodeHeartbeatRequestSchema,
    validationLeaseResponseSchema,
} from "@aura/contracts/judge-protocol";
import { validationCompleteRequestSchema } from "@aura/contracts/validation";
import {
    watermarkCompleteRequestSchema,
    watermarkLeaseResponseSchema,
    watermarkUploadRequestSchema,
} from "@aura/contracts/watermark";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../../../judge/fixtures");
const load = (name: string): unknown => JSON.parse(readFileSync(join(directory, name), "utf8"));

const cases: Array<[string, z.ZodType]> = [
    ["lease-response.json", leaseResponseSchema],
    ["empty-lease-response.json", leaseResponseSchema],
    ["complete-request.json", jobCompleteRequestSchema],
    ["validation-lease-response.json", validationLeaseResponseSchema],
    ["validation-complete-request.json", validationCompleteRequestSchema],
    ["watermark-lease-response.json", watermarkLeaseResponseSchema],
    ["watermark-upload-request.json", watermarkUploadRequestSchema],
    ["watermark-complete-rewritten.json", watermarkCompleteRequestSchema],
    ["watermark-complete-unchanged.json", watermarkCompleteRequestSchema],
    ["watermark-complete-unobserved.json", watermarkCompleteRequestSchema],
    ["env-lease-response.json", envLeaseResponseSchema],
    ["env-complete-request.json", envCompleteRequestSchema],
    ["fail-request.json", jobFailRequestSchema],
    ["enroll-request.json", enrollRequestSchema],
    ["heartbeat-request.json", nodeHeartbeatRequestSchema],
];

describe("judge fixtures", () => {
    for (const [name, schema] of cases) {
        it(`${name} satisfies the contract and survives parsing unchanged`, () => {
            const raw = load(name);
            expect(schema.parse(raw)).toEqual(raw);
        });
    }

    it("are refused when a field the contract does not know is added", () => {
        const raw = z.record(z.string(), z.unknown()).parse(load("fail-request.json"));
        expect(jobFailRequestSchema.safeParse({ ...raw, extra: 1 }).success).toBe(false);
    });
});
