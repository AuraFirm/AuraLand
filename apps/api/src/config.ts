import { assert } from "@aura/contracts/assert";
import { z } from "zod";

// The only place that reads the process environment (docs/kit/04 section 8). Parsed once at
// startup; an invalid configuration stops the process before it serves a single request.

const booleanText = z.enum(["true", "false"]).transform((value) => value === "true");

const configSchema = z
    .object({
        AURA_ENV: z.enum(["local", "test", "staging", "prod"]),
        AURA_ROLE: z.enum(["http"]),
        AURA_HTTP_HOST: z.string().min(1).max(255),
        AURA_HTTP_PORT: z.coerce.number().int().min(1).max(65535),
        AURA_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// url"),
        AURA_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
        // Only the trusted edge may set X-Request-Id; direct clients must not (docs/kit/06 section 3).
        AURA_TRUST_EDGE_REQUEST_ID: booleanText,
    })
    .strict();

export type Config = Readonly<z.infer<typeof configSchema>>;

export function parseConfig(environment: Readonly<Record<string, string | undefined>>): Config {
    const aura: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(environment)) {
        if (key.startsWith("AURA_")) aura[key] = value;
    }
    const config = Object.freeze(configSchema.parse(aura));
    // In production the edge is always present, and debug logs could expose personal data.
    if (config.AURA_ENV === "prod") {
        assert(config.AURA_LOG_LEVEL !== "debug", "debug logging is forbidden in prod");
    }
    return config;
}

export function loadConfigFromProcess(): Config {
    return parseConfig(process.env);
}
