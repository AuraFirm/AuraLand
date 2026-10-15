// Goal: an environment spec cannot describe something unsafe or unscorable, and the isolation rule says what gVisor may
// and may not be used for. Method: one good spec, then one change at a time that must be refused, then the rule's table.

import { describe, expect, it } from "vitest";
import { type EnvSpec, envSpecSchema, ISOLATIONS, isolationAllows } from "./environment.ts";

const good = {
    spec_version: 2,
    kind: "repo_env",
    title: "Fix the failing test",
    image: { digest: `sha256:${"a".repeat(64)}` },
    setup: [["pip", "install", "-r", "requirements.txt"]],
    agent: {
        command: ["python", "agent.py"],
        workspace: "/work",
        time_limit_s: 600,
        memory_limit_mib: 512,
        disk_limit_mib: 256,
        pids_limit: 64,
        output_limit_kib: 256,
    },
    network: { mode: "none" },
    verifier: { command: ["pytest", "-q"], time_limit_s: 120, memory_limit_mib: 512, canaries: 2 },
    integrity: { protected_paths: ["/work/tests"], honeypots: ["/work/.hidden/answers.json"] },
    scoring: { type: "binary" },
};
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Spec = { [key: string]: Json };
// One section of the spec, as a plain object a test can change.
const part = (spec: Spec, key: string): { [key: string]: Json } => {
    const value = spec[key];
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${key} is a section`);
    return value;
};
const change = (patch: (spec: Spec) => void) => {
    const copy: Spec = JSON.parse(JSON.stringify(good));
    patch(copy);
    return envSpecSchema.safeParse(copy).success;
};

describe("envSpecSchema", () => {
    it("accepts a well-formed recipe", () => {
        const parsed: EnvSpec = envSpecSchema.parse(good);
        expect(parsed.network.allow).toEqual([]);
    });

    it("refuses an image that is not pinned by digest, and anything extra", () => {
        expect(change((s) => (s["image"] = { digest: "latest" }))).toBe(false);
        expect(change((s) => (s["image"] = { digest: `sha256:${"a".repeat(63)}` }))).toBe(false);
        expect(change((s) => (s["extra"] = 1))).toBe(false);
        expect(change((s) => (s["spec_version"] = 1))).toBe(false);
    });

    it("refuses commands that are not argvs, paths that escape, and limits out of range", () => {
        expect(change((s) => (part(s, "agent")["command"] = []))).toBe(false);
        expect(change((s) => (part(s, "agent")["command"] = ["sh\0", "x"]))).toBe(false);
        expect(change((s) => (part(s, "agent")["workspace"] = "work"))).toBe(false);
        expect(change((s) => (part(s, "agent")["workspace"] = "/work/../etc"))).toBe(false);
        expect(change((s) => (part(s, "agent")["time_limit_s"] = 3601))).toBe(false);
        expect(change((s) => (part(s, "agent")["time_limit_s"] = 3600))).toBe(true);
        expect(change((s) => (part(s, "agent")["memory_limit_mib"] = 63))).toBe(false);
        expect(change((s) => (part(s, "verifier")["canaries"] = 9))).toBe(false);
    });
});

describe("envSpecSchema network and integrity", () => {
    it("keeps the network off unless an allowlist names DNS hosts, never addresses or private names", () => {
        expect(
            change(
                (s) => (s["network"] = { mode: "none", allow: [{ host: "pypi.org", port: 443 }] }),
            ),
        ).toBe(false);
        expect(change((s) => (s["network"] = { mode: "allowlist", allow: [] }))).toBe(false);
        expect(
            change(
                (s) =>
                    (s["network"] = {
                        mode: "allowlist",
                        allow: [{ host: "pypi.org", port: 443 }],
                    }),
            ),
        ).toBe(true);
        for (const host of [
            "10.0.0.1",
            "169.254.169.254",
            "localhost",
            "db.internal",
            "printer.local",
            "PyPI.org",
            "pypi",
            "a..b.com",
        ]) {
            expect(
                change((s) => (s["network"] = { mode: "allowlist", allow: [{ host, port: 443 }] })),
                host,
            ).toBe(false);
        }
        expect(
            change(
                (s) =>
                    (s["network"] = { mode: "allowlist", allow: [{ host: "pypi.org", port: 0 }] }),
            ),
        ).toBe(false);
    });

    it("refuses a path that is both protected and a honeypot", () => {
        expect(
            change(
                (s) => (s["integrity"] = { protected_paths: ["/work/x"], honeypots: ["/work/x"] }),
            ),
        ).toBe(false);
    });
});

describe("isolationAllows", () => {
    const use = (assuranceLevel: number, customerDelivery: boolean, customerOptedIn = false) => ({
        assuranceLevel,
        customerDelivery,
        customerOptedIn,
    });

    it("lets a microVM do anything", () => {
        for (const level of [0, 1, 2, 3])
            expect(isolationAllows("firecracker", use(level, true))).toBe(true);
    });

    it("keeps gVisor to level 1 and below, and out of customer delivery unless they opted in", () => {
        expect(isolationAllows("gvisor", use(0, false))).toBe(true);
        expect(isolationAllows("gvisor", use(1, false))).toBe(true);
        expect(isolationAllows("gvisor", use(2, false))).toBe(false);
        expect(isolationAllows("gvisor", use(0, true))).toBe(false);
        expect(isolationAllows("gvisor", use(1, true, true))).toBe(true);
        expect(isolationAllows("gvisor", use(2, true, true))).toBe(false); // opting in never raises the level
        expect(() => isolationAllows("gvisor", use(4, false))).toThrow();
        expect(ISOLATIONS).toEqual(["gvisor", "firecracker"]);
    });
});
