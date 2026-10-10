import { z } from "zod";
import type { Config } from "../config.ts";
import { createFixedOriginClient, type FixedOriginClient } from "./egress.ts";

// Every email the system sends goes through this port as a validated, plain-text message. Plain
// text on purpose: nothing to inject into, no tracking pixels, readable everywhere. The adapters
// speak HTTP (the local Mailpit's send API today; a production provider's API when one is chosen),
// so no SMTP library is needed.

export class MailUnavailableError extends Error {
    override readonly name = "MailUnavailableError";
}

const SUBJECT_LENGTH_MAX = 200;
const TEXT_LENGTH_MAX = 10_000;

const messageSchema = z
    .object({
        to: z.email(),
        // No line breaks: a header value must stay on one line.
        subject: z
            .string()
            .min(1)
            .max(SUBJECT_LENGTH_MAX)
            .regex(/^[^\r\n]+$/),
        text: z.string().min(1).max(TEXT_LENGTH_MAX),
    })
    .strict();

export type MailMessage = z.infer<typeof messageSchema>;

export interface MailPort {
    send(message: MailMessage): Promise<void>;
}

export function createMailpitMail(client: FixedOriginClient, from: string): MailPort {
    return {
        async send(input) {
            const message = messageSchema.parse(input);
            const body = {
                From: { Email: from, Name: "AuraLand" },
                To: [{ Email: message.to }],
                Subject: message.subject,
                Text: message.text,
            };
            // The reply may contain provider detail, so only its status is used.
            const status = await client.postJson("/api/v1/send", body).then(
                (reply) => reply.status,
                () => 0,
            );
            if (status !== 200) throw new MailUnavailableError("mail could not be sent");
        },
    };
}

export function createDisabledMail(): MailPort {
    return {
        async send() {
            throw new MailUnavailableError("email sending is disabled");
        },
    };
}

export function createMemoryMail(): MailPort & { readonly outbox: MailMessage[] } {
    const outbox: MailMessage[] = [];
    return {
        outbox,
        async send(input) {
            outbox.push(messageSchema.parse(input));
        },
    };
}

export function createMailFromConfig(config: Config): MailPort {
    if (config.AURA_MAIL_DRIVER === "disabled" || config.AURA_MAIL_API_URL === undefined) {
        return createDisabledMail();
    }
    return createMailpitMail(
        createFixedOriginClient(config.AURA_MAIL_API_URL),
        config.AURA_MAIL_FROM,
    );
}
