import { assert } from "@aura/contracts/assert";
import { z } from "zod";

// The only place that reads the process environment (docs/kit/04 section 8). Parsed once at
// startup; an invalid configuration stops the process before it serves a single request.

// An origin is scheme, host and optional port with nothing else, written the way a browser sends it
// in the Origin header. Comparing the parsed origin back to the text rejects paths, trailing
// slashes, user info, uppercase hosts and explicit default ports.
function isOrigin(text: string): boolean {
    try {
        const url = new URL(text);
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin === text;
    } catch {
        return false;
    }
}

const LOGIN_SECRET_BYTES_MIN = 32;

function isBase64Secret(text: string): boolean {
    if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
    return Buffer.from(text, "base64").length >= LOGIN_SECRET_BYTES_MIN;
}

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
        // The one origin browsers use to reach the site; the CSRF check compares against it.
        AURA_PUBLIC_ORIGIN: z
            .string()
            .refine(isOrigin, "must be a bare origin such as https://app.example"),
        // How sign-in emails are sent. "mailpit" is the local mail catcher (development and tests
        // only); "disabled" sends nothing, so email sign-in is unavailable until a real provider
        // adapter exists. There is deliberately no silent default.
        AURA_MAIL_DRIVER: z.enum(["mailpit", "disabled"]),
        AURA_MAIL_API_URL: z.string().refine(isOrigin, "must be a bare origin").optional(),
        AURA_MAIL_FROM: z.email(),
        // Secret key for hashing login codes and links (HMAC-SHA-256). A short numeric code would be
        // trivial to brute-force from a leaked database without it. Base64, at least 32 bytes.
        AURA_LOGIN_TOKEN_SECRET: z
            .string()
            .refine(isBase64Secret, "must be base64 of at least 32 bytes"),
        // Where task bundles are stored. "s3" is any S3-compatible server (AWS in production,
        // SeaweedFS locally); "memory" keeps objects in the process and exists for tests only.
        AURA_STORAGE_DRIVER: z.enum(["s3", "memory"]),
        // The server the API talks to, and the address browsers use for presigned URLs; they differ
        // when the API reaches storage over an internal network.
        AURA_S3_ENDPOINT: z.string().refine(isOrigin, "must be a bare origin").optional(),
        AURA_S3_PUBLIC_ENDPOINT: z.string().refine(isOrigin, "must be a bare origin").optional(),
        AURA_S3_BUCKET: z
            .string()
            .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "must be a valid bucket name")
            .optional(),
        AURA_S3_REGION: z
            .string()
            .regex(/^[a-z0-9-]{2,30}$/)
            .optional(),
        AURA_S3_ACCESS_KEY_ID: z.string().min(1).max(200).optional(),
        AURA_S3_SECRET_ACCESS_KEY: z.string().min(1).max(400).optional(),
        // Sign-in with GitHub or Google. Each provider is on only when both of its values are set.
        AURA_OAUTH_GITHUB_CLIENT_ID: z.string().min(1).max(200).optional(),
        AURA_OAUTH_GITHUB_CLIENT_SECRET: z.string().min(1).max(400).optional(),
        AURA_OAUTH_GOOGLE_CLIENT_ID: z.string().min(1).max(200).optional(),
        AURA_OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).max(400).optional(),
    })
    .strict();

export type Config = Readonly<z.infer<typeof configSchema>>;

export function parseConfig(environment: Readonly<Record<string, string | undefined>>): Config {
    const aura: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(environment)) {
        // AURA_TEST_* values belong to the test suites and share the same .env file.
        if (key.startsWith("AURA_") && !key.startsWith("AURA_TEST_")) aura[key] = value;
    }
    const config = Object.freeze(configSchema.parse(aura));
    // In production the edge is always present, and debug logs could expose personal data.
    if (config.AURA_ENV === "prod") {
        assert(config.AURA_LOG_LEVEL !== "debug", "debug logging is forbidden in prod");
    }
    // Cookies marked Secure are never sent over plain http, so shared environments must use https.
    if (config.AURA_ENV === "staging" || config.AURA_ENV === "prod") {
        assert(
            config.AURA_PUBLIC_ORIGIN.startsWith("https://"),
            "AURA_PUBLIC_ORIGIN must use https here",
        );
    }
    if (config.AURA_MAIL_DRIVER === "mailpit") {
        assert(
            config.AURA_MAIL_API_URL !== undefined,
            "AURA_MAIL_API_URL is required for the mailpit driver",
        );
        assert(
            config.AURA_ENV === "local" || config.AURA_ENV === "test",
            "the mailpit driver is for local development and tests only",
        );
    }
    assertStorageSettings(config);
    for (const provider of ["GITHUB", "GOOGLE"]) {
        const id = aura[`AURA_OAUTH_${provider}_CLIENT_ID`];
        const secret = aura[`AURA_OAUTH_${provider}_CLIENT_SECRET`];
        assert(
            (id === undefined) === (secret === undefined),
            `set both or neither of the ${provider} OAuth client id and secret`,
        );
    }
    return config;
}

const S3_SETTING_NAMES = [
    "AURA_S3_ENDPOINT",
    "AURA_S3_PUBLIC_ENDPOINT",
    "AURA_S3_BUCKET",
    "AURA_S3_REGION",
    "AURA_S3_ACCESS_KEY_ID",
    "AURA_S3_SECRET_ACCESS_KEY",
] as const;

// The S3 driver needs all of its settings; the in-memory driver is for tests and nothing else.
function assertStorageSettings(config: Config): void {
    if (config.AURA_STORAGE_DRIVER === "memory") {
        assert(config.AURA_ENV === "test", "the memory storage driver is for tests only");
        return;
    }
    for (const name of S3_SETTING_NAMES) {
        assert(config[name] !== undefined, `${name} is required for the s3 storage driver`);
    }
}

export interface S3ClientSettings {
    readonly region: string;
    readonly bucket: string;
    readonly endpoint: string;
    readonly publicEndpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
}

// The S3 settings, checked complete at startup by parseConfig; null when the driver is "memory".
export function s3ClientSettings(config: Config): S3ClientSettings | null {
    const { AURA_S3_ENDPOINT: endpoint, AURA_S3_PUBLIC_ENDPOINT: publicEndpoint } = config;
    const { AURA_S3_BUCKET: bucket, AURA_S3_REGION: region } = config;
    const { AURA_S3_ACCESS_KEY_ID: accessKeyId, AURA_S3_SECRET_ACCESS_KEY: secretAccessKey } =
        config;
    if (config.AURA_STORAGE_DRIVER === "memory") return null;
    assert(
        endpoint !== undefined &&
            publicEndpoint !== undefined &&
            bucket !== undefined &&
            region !== undefined &&
            accessKeyId !== undefined &&
            secretAccessKey !== undefined,
        "S3 settings are complete",
    );
    return { region, bucket, endpoint, publicEndpoint, accessKeyId, secretAccessKey };
}

export interface OAuthClientSettings {
    readonly github?: { readonly clientId: string; readonly clientSecret: string };
    readonly google?: { readonly clientId: string; readonly clientSecret: string };
}

// Which OAuth providers are configured, with their credentials.
export function oauthClientSettings(config: Config): OAuthClientSettings {
    const github =
        config.AURA_OAUTH_GITHUB_CLIENT_ID !== undefined &&
        config.AURA_OAUTH_GITHUB_CLIENT_SECRET !== undefined
            ? {
                  clientId: config.AURA_OAUTH_GITHUB_CLIENT_ID,
                  clientSecret: config.AURA_OAUTH_GITHUB_CLIENT_SECRET,
              }
            : undefined;
    const google =
        config.AURA_OAUTH_GOOGLE_CLIENT_ID !== undefined &&
        config.AURA_OAUTH_GOOGLE_CLIENT_SECRET !== undefined
            ? {
                  clientId: config.AURA_OAUTH_GOOGLE_CLIENT_ID,
                  clientSecret: config.AURA_OAUTH_GOOGLE_CLIENT_SECRET,
              }
            : undefined;
    return {
        ...(github === undefined ? {} : { github }),
        ...(google === undefined ? {} : { google }),
    };
}

// The key for hashing login codes and links, decoded from the validated base64 setting.
export function loginTokenKey(config: Config): Buffer {
    return Buffer.from(config.AURA_LOGIN_TOKEN_SECRET, "base64");
}

// Secure cookies and the __Host- prefix are used everywhere except local development and tests,
// where browsers do not treat plain-http localhost uniformly.
export function usesSecureCookies(config: Config): boolean {
    return config.AURA_ENV === "staging" || config.AURA_ENV === "prod";
}

export function loadConfigFromProcess(): Config {
    return parseConfig(process.env);
}
