// Goal: API responses are explicit allowlists. Anything not named here must fail to serialize, so a
// future column (such as a token hash) can never leak just by being selected.
import { describe, expect, it } from "vitest";
import { encodeId } from "../ids.ts";
import { deviceSchema, meResponseSchema, sessionsResponseSchema } from "./identity.ts";

const UUID = "018f0000-0000-7000-8000-00000000000a";
const me = {
    id: encodeId("usr", UUID),
    email: "a@example.com",
    email_verified: true,
    handle: "alice",
    display_name: "Alice",
    platform_role: "none",
};
const device = {
    id: encodeId("ses", UUID),
    auth_method: "passkey",
    created_at: "2026-10-10T10:00:00.000Z",
    last_seen_at: "2026-10-10T10:05:00.000Z",
    idle_expires_at: "2026-10-17T10:05:00.000Z",
    absolute_expires_at: "2026-11-09T10:00:00.000Z",
    ip_network: "203.0.113.0/24",
    user_agent: "Firefox",
    current: true,
};

describe("meResponseSchema", () => {
    it("accepts a complete response, including a user with no profile yet", () => {
        expect(meResponseSchema.safeParse(me).success).toBe(true);
        expect(
            meResponseSchema.safeParse({ ...me, handle: null, display_name: null }).success,
        ).toBe(true);
    });

    it("rejects unknown fields, wrong id types and unknown roles", () => {
        expect(meResponseSchema.safeParse({ ...me, token_hash: "abc" }).success).toBe(false);
        expect(meResponseSchema.safeParse({ ...me, id: encodeId("org", UUID) }).success).toBe(
            false,
        );
        expect(meResponseSchema.safeParse({ ...me, platform_role: "root" }).success).toBe(false);
    });
});

describe("sessionsResponseSchema", () => {
    it("accepts a list of devices and an empty list", () => {
        expect(sessionsResponseSchema.safeParse({ items: [device] }).success).toBe(true);
        expect(sessionsResponseSchema.safeParse({ items: [] }).success).toBe(true);
    });

    it("rejects any extra field on a device, such as the token or its hash", () => {
        for (const extra of ["token", "token_hash", "user_id", "revoked_at"]) {
            expect(deviceSchema.safeParse({ ...device, [extra]: "x" }).success, extra).toBe(false);
        }
    });

    it("rejects malformed times, a session id of the wrong kind and unknown methods", () => {
        expect(deviceSchema.safeParse({ ...device, created_at: "yesterday" }).success).toBe(false);
        expect(deviceSchema.safeParse({ ...device, id: encodeId("usr", UUID) }).success).toBe(
            false,
        );
        expect(deviceSchema.safeParse({ ...device, auth_method: "password" }).success).toBe(false);
    });
});
