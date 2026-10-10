import { withRequestContext } from "@aura/db/context";
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { pino } from "pino";
import { vi } from "vitest";
import { type AppDeps, createApp } from "./app.ts";
import { parseConfig } from "./config.ts";
import { createPgSessionStore } from "./modules/identity/queries.ts";
import { createSession, type SessionDeps } from "./modules/identity/service.ts";
import { createMemoryMail, type MailPort } from "./platform/mail.ts";
import { createFakeClock, createSeededRng } from "./sim/world.ts";

// Shared fixtures for tests that drive the real HTTP app against a real PostgreSQL: two users, a
// controllable clock, a way to log someone in, and the headers a browser page of ours would send.

export const ALICE = "018f0000-0000-7000-8000-0000000000a1";
export const BOB = "018f0000-0000-7000-8000-0000000000b2";
export const ORIGIN = "http://localhost:3000";
export const START = 1_800_000_000_000;

const BASE_ENV = {
    AURA_ENV: "test",
    AURA_ROLE: "http",
    AURA_HTTP_HOST: "127.0.0.1",
    AURA_HTTP_PORT: "3001",
    AURA_DATABASE_URL: "postgres://localhost/none",
    AURA_LOG_LEVEL: "error",
    AURA_TRUST_EDGE_REQUEST_ID: "false",
    AURA_PUBLIC_ORIGIN: ORIGIN,
    AURA_MAIL_DRIVER: "mailpit",
    AURA_MAIL_API_URL: "http://127.0.0.1:8025",
    AURA_MAIL_FROM: "no-reply@auraland.test",
    AURA_LOGIN_TOKEN_SECRET: Buffer.alloc(32, 7).toString("base64"),
};

const IDENTITY_CONTEXT = {
    role: "aura_auth",
    actorKind: "anonymous",
    userId: null,
    orgIds: [],
} as const;

export interface Harness {
    readonly db: TestDatabase;
    readonly clock: ReturnType<typeof createFakeClock>;
    readonly onInvariantViolation: ReturnType<typeof vi.fn>;
    // Every email the app "sent" in this harness.
    readonly mail: ReturnType<typeof createMemoryMail>;
    // Every log line the app wrote in this harness (no redaction, so leaks show).
    readonly logs: string[];
    app(
        env?: Record<string, string>,
        mail?: MailPort,
        oauthProviders?: AppDeps["oauthProviders"],
    ): ReturnType<typeof createApp>;
    asIdentity<T>(work: (deps: SessionDeps) => Promise<T>): Promise<T>;
    login(userId: string, privileged?: boolean): ReturnType<typeof createSession>;
    request(
        path: string,
        init?: RequestInit & { headers?: Record<string, string> },
    ): Response | Promise<Response>;
    drop(): Promise<void>;
}

// Headers for a request from our own page: the session cookie (if any), a matching Origin, the
// browser's same-origin statement and the custom header every state-changing request needs.
export function browser(
    token: string | null,
    extra: Record<string, string> = {},
): Record<string, string> {
    const headers: Record<string, string> = {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "x-aura-request": "1",
        ...extra,
    };
    if (token !== null) headers["cookie"] = `aura_session=${token}`;
    return headers;
}

export async function createHarness(): Promise<Harness> {
    const db = await createMigratedTestDatabase();
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at) values
        (${ALICE}, 'alice@example.com', now()), (${BOB}, 'bob@example.com', now())`;
    await sql`insert into profiles (user_id, handle, display_name) values
        (${ALICE}, 'alice', 'Alice'), (${BOB}, 'bob', 'Bob')`;
    const clock = createFakeClock(START);
    const rng = createSeededRng(2026);
    const onInvariantViolation = vi.fn();
    const mail = createMemoryMail();
    const logs: string[] = [];
    const app = (
        env: Record<string, string> = {},
        sender: MailPort = mail,
        oauthProviders: AppDeps["oauthProviders"] = new Map(),
    ) =>
        createApp({
            config: parseConfig({ ...BASE_ENV, ...env }),
            logger: pino({ level: "debug" }, { write: (line: string) => void logs.push(line) }),
            clock,
            rng,
            database: db.database,
            mail: sender,
            oauthProviders,
            pingDatabase: async () => undefined,
            onInvariantViolation,
        });
    const asIdentity = <T>(work: (deps: SessionDeps) => Promise<T>) =>
        withRequestContext(sql, IDENTITY_CONTEXT, (tx) =>
            work({ store: createPgSessionStore(tx), clock, rng }),
        );
    return {
        db,
        clock,
        onInvariantViolation,
        mail,
        logs,
        app,
        asIdentity,
        login: (userId, privileged = false) =>
            asIdentity((deps) =>
                createSession(deps, { userId, authMethod: "passkey", privileged }),
            ),
        request: (path, init = {}) => app().request(`/api/v1${path}`, init),
        drop: () => db.drop(),
    };
}
