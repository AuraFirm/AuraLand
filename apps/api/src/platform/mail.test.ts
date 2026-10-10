// Goal: mail leaves only as a validated message through one port; the Mailpit adapter sends exactly
// the documented request; failures surface as one typed error with no provider detail; the disabled
// driver sends nothing; and the real Mailpit receives and shows what we send.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFixedOriginClient } from "./egress.ts";
import {
    createDisabledMail,
    createMailpitMail,
    createMemoryMail,
    type MailMessage,
    MailUnavailableError,
} from "./mail.ts";
import { mailpitUrl, startTestServer, type TestServer } from "./test-helpers.ts";

const message: MailMessage = {
    to: "ada@example.com",
    subject: "Your sign-in code",
    text: "Code: 1234 5678",
};

let server: TestServer;
let origin = "";
let status = 200;
const received: Array<{ url: string; body: unknown }> = [];

beforeAll(async () => {
    server = await startTestServer((request, body, response) => {
        received.push({ url: request.url ?? "", body: JSON.parse(body) });
        response.writeHead(status).end('{"ID":"abc"}');
    });
    origin = server.origin;
});
afterAll(async () => {
    await server.close();
});

describe("mailpit adapter against a fake server", () => {
    const mail = () =>
        createMailpitMail(
            createFixedOriginClient(origin, { timeoutMs: 500 }),
            "no-reply@auraland.test",
        );

    it("posts the documented send request", async () => {
        status = 200;
        received.length = 0;
        await mail().send(message);
        expect(received).toEqual([
            {
                url: "/api/v1/send",
                body: {
                    From: { Email: "no-reply@auraland.test", Name: "AuraLand" },
                    To: [{ Email: "ada@example.com" }],
                    Subject: "Your sign-in code",
                    Text: "Code: 1234 5678",
                },
            },
        ]);
    });

    it("turns any failure into one typed error that carries no provider detail", async () => {
        status = 500;
        const failure = await mail()
            .send(message)
            .catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(MailUnavailableError);
        expect(String(failure)).not.toContain("abc");
        const dead = createMailpitMail(
            createFixedOriginClient("http://127.0.0.1:1", { timeoutMs: 300 }),
            "a@b.co",
        );
        expect(await dead.send(message).catch((e: unknown) => e)).toBeInstanceOf(
            MailUnavailableError,
        );
    });

    it("rejects invalid messages before any request is made", async () => {
        status = 200;
        received.length = 0;
        const bad: MailMessage[] = [
            { ...message, to: "not an email" },
            { ...message, to: "a@b.com\r\nBcc: x@y.zz" },
            { ...message, subject: "Hi\r\nBcc: x@y.zz" },
            { ...message, subject: "" },
            { ...message, subject: "s".repeat(201) },
            { ...message, text: "" },
            { ...message, text: "t".repeat(10_001) },
        ];
        for (const candidate of bad) await expect(mail().send(candidate)).rejects.toThrow();
        expect(received).toEqual([]);
        await expect(
            mail().send({ ...message, subject: "s".repeat(200), text: "t".repeat(10_000) }),
        ).resolves.toBeUndefined();
    });
});

describe("disabled and memory adapters", () => {
    it("the disabled adapter sends nothing and says so", async () => {
        await expect(createDisabledMail().send(message)).rejects.toBeInstanceOf(
            MailUnavailableError,
        );
    });

    it("the memory adapter records validated messages in order", async () => {
        const mail = createMemoryMail();
        await mail.send(message);
        await mail.send({ ...message, to: "grace@example.com" });
        expect(mail.outbox.map((m) => m.to)).toEqual(["ada@example.com", "grace@example.com"]);
        await expect(mail.send({ ...message, to: "nope" })).rejects.toThrow();
        expect(mail.outbox.length).toBe(2);
    });
});

// Needs the local Mailpit (docker compose up). Fails, not skips, without it, like the database tests.
const listSchema = z.object({
    messages: z.array(
        z.object({
            ID: z.string(),
            Subject: z.string(),
            To: z.array(z.object({ Address: z.string() })),
        }),
    ),
});
const fullSchema = z.object({ Text: z.string() });

describe("real Mailpit", () => {
    it("receives a message and shows it back with the same recipient, subject and text", async () => {
        const base = mailpitUrl();
        await fetch(`${base}/api/v1/messages`, { method: "DELETE" });
        const unique = `Code ${Date.now()}`;
        const mail = createMailpitMail(createFixedOriginClient(base), "no-reply@auraland.test");
        await mail.send({ ...message, text: unique });
        const list = listSchema.parse(await (await fetch(`${base}/api/v1/messages`)).json());
        expect(list.messages.length).toBe(1);
        expect(list.messages[0]?.Subject).toBe("Your sign-in code");
        expect(list.messages[0]?.To[0]?.Address).toBe("ada@example.com");
        const id = list.messages[0]?.ID ?? "";
        const full = fullSchema.parse(await (await fetch(`${base}/api/v1/message/${id}`)).json());
        expect(full.Text.trim()).toBe(unique);
    });
});
