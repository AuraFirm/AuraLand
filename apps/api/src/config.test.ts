// Goal: configuration is validated once, completely, and fails closed.
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";

const valid = {
    AURA_ENV: "local",
    AURA_ROLE: "http",
    AURA_HTTP_HOST: "127.0.0.1",
    AURA_HTTP_PORT: "3001",
    AURA_DATABASE_URL: "postgres://localhost/aura",
    AURA_LOG_LEVEL: "info",
    AURA_TRUST_EDGE_REQUEST_ID: "false",
};

describe("parseConfig", () => {
    it("parses a valid environment into a frozen config and ignores non-AURA variables", () => {
        const config = parseConfig({ ...valid, PATH: "/usr/bin", HOME: "/root" });
        expect(config.AURA_HTTP_PORT).toBe(3001);
        expect(config.AURA_TRUST_EDGE_REQUEST_ID).toBe(false);
        expect(Object.isFrozen(config)).toBe(true);
    });

    it("rejects missing, malformed and out-of-range values", () => {
        const withoutPort: Record<string, string> = { ...valid };
        delete withoutPort["AURA_HTTP_PORT"];
        expect(() => parseConfig(withoutPort)).toThrow();
        expect(() => parseConfig({ ...valid, AURA_HTTP_PORT: "0" })).toThrow();
        expect(() => parseConfig({ ...valid, AURA_HTTP_PORT: "65536" })).toThrow();
        expect(() => parseConfig({ ...valid, AURA_HTTP_PORT: "65535" })).not.toThrow();
        expect(() => parseConfig({ ...valid, AURA_DATABASE_URL: "mysql://x" })).toThrow();
        expect(() => parseConfig({ ...valid, AURA_ENV: "dev" })).toThrow();
        expect(() => parseConfig({ ...valid, AURA_TRUST_EDGE_REQUEST_ID: "yes" })).toThrow();
    });

    it("rejects unknown AURA_ variables so typos do not pass silently", () => {
        expect(() => parseConfig({ ...valid, AURA_HTTP_PROT: "1" })).toThrow();
    });

    it("forbids debug logging in prod", () => {
        expect(() => parseConfig({ ...valid, AURA_ENV: "prod", AURA_LOG_LEVEL: "debug" })).toThrow(
            /debug/,
        );
        expect(() =>
            parseConfig({ ...valid, AURA_ENV: "prod", AURA_LOG_LEVEL: "info" }),
        ).not.toThrow();
    });
});
