// Goal: configuration is validated once, completely, and fails closed.
import { describe, expect, it } from "vitest";
import { oauthClientSettings, parseConfig } from "./config.ts";

const valid = {
    AURA_ENV: "local",
    AURA_ROLE: "http",
    AURA_HTTP_HOST: "127.0.0.1",
    AURA_HTTP_PORT: "3001",
    AURA_DATABASE_URL: "postgres://localhost/aura",
    AURA_LOG_LEVEL: "info",
    AURA_TRUST_EDGE_REQUEST_ID: "false",
    AURA_PUBLIC_ORIGIN: "http://localhost:3000",
    AURA_MAIL_DRIVER: "mailpit",
    AURA_MAIL_API_URL: "http://127.0.0.1:8025",
    AURA_MAIL_FROM: "no-reply@auraland.test",
    AURA_LOGIN_TOKEN_SECRET: Buffer.alloc(32, 7).toString("base64"),
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
        const prod = {
            ...valid,
            AURA_ENV: "prod",
            AURA_MAIL_DRIVER: "disabled",
            AURA_PUBLIC_ORIGIN: "https://app.example",
        };
        expect(() => parseConfig({ ...prod, AURA_LOG_LEVEL: "debug" })).toThrow(/debug/);
        expect(() => parseConfig({ ...prod, AURA_LOG_LEVEL: "info" })).not.toThrow();
    });
});

describe("AURA_PUBLIC_ORIGIN", () => {
    it("accepts a bare origin and lets local and test use http", () => {
        expect(parseConfig({ ...valid }).AURA_PUBLIC_ORIGIN).toBe("http://localhost:3000");
        const prod = {
            ...valid,
            AURA_ENV: "prod",
            AURA_MAIL_DRIVER: "disabled",
            AURA_PUBLIC_ORIGIN: "https://app.auraland.example",
        };
        expect(parseConfig(prod).AURA_PUBLIC_ORIGIN).toBe("https://app.auraland.example");
        expect(() => parseConfig({ ...valid, AURA_ENV: "test" })).not.toThrow();
    });

    it("rejects anything that is not exactly an origin", () => {
        for (const bad of [
            "https://a.example/",
            "https://a.example/path",
            "https://a.example?x=1",
            "https://user@a.example",
            "https://a.example:abc",
            "ftp://a.example",
            "a.example",
            "",
            "https://A.EXAMPLE",
        ]) {
            expect(() => parseConfig({ ...valid, AURA_PUBLIC_ORIGIN: bad }), bad).toThrow();
        }
    });

    it("requires https in staging and prod, and is required everywhere", () => {
        for (const env of ["staging", "prod"]) {
            const insecure = { ...valid, AURA_ENV: env, AURA_PUBLIC_ORIGIN: "http://app.example" };
            expect(() => parseConfig(insecure), env).toThrow(/https/);
        }
        const without: Record<string, string> = { ...valid };
        delete without["AURA_PUBLIC_ORIGIN"];
        expect(() => parseConfig(without)).toThrow();
    });
});

describe("mail settings", () => {
    it("lets local and test use the mailpit driver and requires its API URL", () => {
        expect(parseConfig({ ...valid }).AURA_MAIL_DRIVER).toBe("mailpit");
        const withoutUrl: Record<string, string> = { ...valid };
        delete withoutUrl["AURA_MAIL_API_URL"];
        expect(() => parseConfig(withoutUrl)).toThrow(/AURA_MAIL_API_URL/);
    });

    it("forbids the development mail catcher in staging and prod", () => {
        for (const env of ["staging", "prod"]) {
            const attempt = { ...valid, AURA_ENV: env, AURA_PUBLIC_ORIGIN: "https://app.example" };
            expect(() => parseConfig(attempt), env).toThrow(/mailpit/);
        }
    });

    it("accepts the disabled driver everywhere, without an API URL", () => {
        const disabled: Record<string, string> = {
            ...valid,
            AURA_ENV: "prod",
            AURA_PUBLIC_ORIGIN: "https://app.example",
            AURA_MAIL_DRIVER: "disabled",
        };
        delete disabled["AURA_MAIL_API_URL"];
        expect(() => parseConfig(disabled)).not.toThrow();
    });

    it("requires a bare http(s) origin for the API URL and a valid sender address", () => {
        for (const bad of [
            "http://127.0.0.1:8025/",
            "http://127.0.0.1:8025/api",
            "ftp://x",
            "127.0.0.1:8025",
        ]) {
            expect(() => parseConfig({ ...valid, AURA_MAIL_API_URL: bad }), bad).toThrow();
        }
        for (const bad of ["", "not-an-email", "a b@c.com"]) {
            expect(() => parseConfig({ ...valid, AURA_MAIL_FROM: bad }), bad).toThrow();
        }
    });
});

describe("AURA_LOGIN_TOKEN_SECRET", () => {
    it("must decode to at least 32 bytes of base64", () => {
        const secret = (bytes: number) => Buffer.alloc(bytes, 9).toString("base64");
        expect(() => parseConfig({ ...valid, AURA_LOGIN_TOKEN_SECRET: secret(32) })).not.toThrow();
        expect(() => parseConfig({ ...valid, AURA_LOGIN_TOKEN_SECRET: secret(31) })).toThrow(
            /32 bytes/,
        );
        for (const bad of ["", "not base64!!", "====", secret(32).slice(0, -2)]) {
            expect(() => parseConfig({ ...valid, AURA_LOGIN_TOKEN_SECRET: bad }), bad).toThrow();
        }
    });

    it("is never present in an error message", () => {
        const secret = Buffer.alloc(8, 5).toString("base64");
        try {
            parseConfig({ ...valid, AURA_LOGIN_TOKEN_SECRET: secret });
        } catch (error) {
            expect(String(error)).not.toContain(secret);
        }
    });
});

describe("OAuth provider settings", () => {
    it("is off by default and on only when both values of a provider are set", () => {
        expect(oauthClientSettings(parseConfig(valid))).toEqual({});
        const config = parseConfig({
            ...valid,
            AURA_OAUTH_GITHUB_CLIENT_ID: "id",
            AURA_OAUTH_GITHUB_CLIENT_SECRET: "secret",
        });
        expect(oauthClientSettings(config)).toEqual({
            github: { clientId: "id", clientSecret: "secret" },
        });
    });

    it("refuses half-configured providers and empty values", () => {
        expect(() => parseConfig({ ...valid, AURA_OAUTH_GOOGLE_CLIENT_ID: "id" })).toThrow(
            /both or neither/,
        );
        expect(() => parseConfig({ ...valid, AURA_OAUTH_GOOGLE_CLIENT_SECRET: "s" })).toThrow(
            /both or neither/,
        );
        expect(() =>
            parseConfig({
                ...valid,
                AURA_OAUTH_GITHUB_CLIENT_ID: "",
                AURA_OAUTH_GITHUB_CLIENT_SECRET: "s",
            }),
        ).toThrow();
    });
});
