// Goal: an audit entry must be fully validated before it can reach the append-only log, because
// nothing can be corrected afterwards.
import { describe, expect, it } from "vitest";
import { AUDIT_DETAIL_BYTES_MAX, auditEntrySchema } from "./audit.ts";

const USER = "018f0000-0000-7000-8000-00000000000a";
const valid = {
    actorKind: "user",
    actorUserId: USER,
    orgId: null,
    action: "auth.login_succeeded",
    target: `usr_${USER}`,
    ip: "203.0.113.7",
    detail: { method: "passkey" },
};

const ok = (value: unknown) => auditEntrySchema.safeParse(value).success;

describe("auditEntrySchema", () => {
    it("accepts a valid entry, including the minimum (no target, ip or detail)", () => {
        expect(ok(valid)).toBe(true);
        expect(
            ok({ actorKind: "system", actorUserId: null, orgId: null, action: "audit.checked" }),
        ).toBe(true);
    });

    it("rejects bad action names", () => {
        for (const action of [
            "",
            "login",
            "Auth.Login",
            "auth..login",
            "auth.login ",
            "auth.login;drop",
        ]) {
            expect(ok({ ...valid, action })).toBe(false);
        }
    });

    it("rejects unknown fields, bad ids, bad addresses and unknown actor kinds", () => {
        expect(ok({ ...valid, extra: 1 })).toBe(false);
        expect(ok({ ...valid, actorUserId: "not-a-uuid" })).toBe(false);
        expect(ok({ ...valid, orgId: USER.toUpperCase() })).toBe(false);
        expect(ok({ ...valid, ip: "999.1.1.1" })).toBe(false);
        expect(ok({ ...valid, ip: "2001:db8::1" })).toBe(true);
        expect(ok({ ...valid, actorKind: "root" })).toBe(false);
    });

    it("keeps detail within its byte limit, measured exactly", () => {
        const detailOfBytes = (n: number) => ({ k: "x".repeat(n - '{"k":""}'.length) });
        expect(JSON.stringify(detailOfBytes(AUDIT_DETAIL_BYTES_MAX)).length).toBe(
            AUDIT_DETAIL_BYTES_MAX,
        );
        expect(ok({ ...valid, detail: detailOfBytes(AUDIT_DETAIL_BYTES_MAX) })).toBe(true);
        expect(ok({ ...valid, detail: detailOfBytes(AUDIT_DETAIL_BYTES_MAX + 1) })).toBe(false);
    });

    it("rejects control characters in the target", () => {
        expect(ok({ ...valid, target: "a\nb" })).toBe(false);
        expect(ok({ ...valid, target: "x".repeat(201) })).toBe(false);
    });
});
