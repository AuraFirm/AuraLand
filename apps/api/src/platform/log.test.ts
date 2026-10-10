// Goal: if a handler ever logs a secret by mistake, the redaction list of the real logger hides it.
import { describe, expect, it } from "vitest";
import { createLogger } from "./log.ts";

describe("createLogger redaction", () => {
    it("hides credentials by field name, one level down", () => {
        const lines: string[] = [];
        const logger = createLogger("info", { write: (line: string) => void lines.push(line) });
        logger.info(
            {
                req: {
                    token: "t0k3n",
                    code: "12345678",
                    otp: "987654",
                    key: "aura_secretkey",
                    binding: "bindingvalue",
                    email: "someone@example.com",
                    secret: "s3cr3t",
                    password: "hunter2",
                },
            },
            "a handler logged too much",
        );
        const text = lines.join("");
        for (const leaked of [
            "t0k3n",
            "12345678",
            "987654",
            "aura_secretkey",
            "bindingvalue",
            "someone@example.com",
            "s3cr3t",
            "hunter2",
        ]) {
            expect(text, leaked).not.toContain(leaked);
        }
        expect(text).toContain("[redacted]");
    });

    it("keeps ordinary fields", () => {
        const lines: string[] = [];
        createLogger("info", { write: (line: string) => void lines.push(line) }).info(
            { route: "/x", status: 200 },
            "ok",
        );
        expect(lines.join("")).toContain('"status":200');
    });
});
