"use client";

import { authMethodsResponseSchema } from "@aura/contracts/api/account";
import { oauthStartResponseSchema } from "@aura/contracts/api/oauth";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { signInWithPasskey, usePasskeysSupported } from "../lib/passkeys.ts";
import { button, buttonQuiet, input, panel } from "../lib/styles.ts";

type Methods = z.infer<typeof authMethodsResponseSchema>;
const done = z.object({ status: z.string() }).passthrough();

const PROVIDER_LABEL = { github: "GitHub", google: "Google" } as const;

export function SignInForm() {
    const [methods, setMethods] = useState<Methods | null>(null);
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const supported = usePasskeysSupported();

    useEffect(() => {
        apiGet("/auth/methods", authMethodsResponseSchema).then(setMethods, () => {
            setFailed(true);
            setMessage("Could not load the sign-in options. Reload the page.");
        });
    }, []);

    const report = (error: unknown) => {
        setFailed(true);
        setMessage(messageOf(error));
    };
    const finish = () => window.location.assign("/account");

    return (
        <div className="flex flex-col gap-6">
            <p
                role={failed ? "alert" : "status"}
                aria-live="polite"
                className={failed ? "text-danger" : "text-muted"}
            >
                {message}
            </p>
            {supported && <PasskeySection onError={report} onDone={finish} />}
            {methods?.email && <EmailSection onError={report} onDone={finish} />}
            {methods !== null && methods.oauth.length > 0 && (
                <OAuthSection providers={methods.oauth} onError={report} />
            )}
        </div>
    );
}

interface SectionProps {
    readonly onError: (error: unknown) => void;
    readonly onDone: () => void;
}

function PasskeySection({ onError, onDone }: SectionProps) {
    const [busy, setBusy] = useState(false);
    const run = async () => {
        setBusy(true);
        try {
            await signInWithPasskey();
            onDone();
        } catch (error) {
            onError(error);
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className={panel} aria-labelledby="passkey-heading">
            <h2 id="passkey-heading" className="mb-2 text-lg font-semibold">
                Passkey
            </h2>
            <p className="mb-3 text-muted">Use the passkey on this device or a security key.</p>
            <button type="button" className={button} disabled={busy} onClick={run}>
                Sign in with a passkey
            </button>
        </section>
    );
}

function EmailSection({ onError, onDone }: SectionProps) {
    const [email, setEmail] = useState("");
    const [sent, setSent] = useState(false);
    return (
        <section className={panel} aria-labelledby="email-heading">
            <h2 id="email-heading" className="mb-2 text-lg font-semibold">
                Email
            </h2>
            {sent ? (
                <EmailCodeForm
                    email={email}
                    onBack={() => setSent(false)}
                    onError={onError}
                    onDone={onDone}
                />
            ) : (
                <EmailStartForm
                    email={email}
                    setEmail={setEmail}
                    onSent={() => setSent(true)}
                    onError={onError}
                />
            )}
        </section>
    );
}

interface StartProps {
    readonly email: string;
    readonly setEmail: (value: string) => void;
    readonly onSent: () => void;
    readonly onError: (error: unknown) => void;
}

function EmailStartForm({ email, setEmail, onSent, onError }: StartProps) {
    const [busy, setBusy] = useState(false);
    const start = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            await apiSend("/auth/email/start", done, { method: "POST", body: { email } });
            onSent();
        } catch (error) {
            onError(error);
        } finally {
            setBusy(false);
        }
    };
    return (
        <form onSubmit={start} className="flex flex-col gap-3">
            <label htmlFor="email">Email address</label>
            <input
                id="email"
                type="email"
                className={input}
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" className={button} disabled={busy}>
                Email me a link and code
            </button>
        </form>
    );
}

function EmailCodeForm({
    email,
    onBack,
    onError,
    onDone,
}: SectionProps & { email: string; onBack: () => void }) {
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const verify = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            await apiSend("/auth/email/verify", done, { method: "POST", body: { code } });
            onDone();
        } catch (error) {
            onError(error);
        } finally {
            setBusy(false);
        }
    };
    return (
        <form onSubmit={verify} className="flex flex-col gap-3">
            <p className="text-muted">
                We sent a link and an 8-digit code to {email}. Open the link in this browser, or
                enter the code.
            </p>
            <label htmlFor="code">Code</label>
            <input
                id="code"
                className={input}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
            />
            <div className="flex gap-3">
                <button type="submit" className={button} disabled={busy}>
                    Sign in
                </button>
                <button type="button" className={buttonQuiet} onClick={onBack}>
                    Use a different email
                </button>
            </div>
        </form>
    );
}

function OAuthSection({
    providers,
    onError,
}: {
    providers: Methods["oauth"];
    onError: (error: unknown) => void;
}) {
    const go = async (provider: Methods["oauth"][number]) => {
        try {
            const started = await apiSend(
                `/auth/oauth/${provider}/start`,
                oauthStartResponseSchema,
                { method: "POST", body: {} },
            );
            window.location.assign(started.authorization_url);
        } catch (error) {
            onError(error);
        }
    };
    return (
        <section className={panel} aria-labelledby="oauth-heading">
            <h2 id="oauth-heading" className="mb-2 text-lg font-semibold">
                Another account
            </h2>
            <div className="flex gap-3">
                {providers.map((provider) => (
                    <button
                        key={provider}
                        type="button"
                        className={buttonQuiet}
                        onClick={() => go(provider)}
                    >
                        Continue with {PROVIDER_LABEL[provider]}
                    </button>
                ))}
            </div>
        </section>
    );
}
