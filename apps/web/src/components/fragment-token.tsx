"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, apiSend, messageOf } from "../lib/api.ts";
import { rememberNext, takeNext } from "../lib/next-path.ts";

const result = z.object({ status: z.string() }).passthrough();

interface Props {
    // The API route that spends the token.
    readonly path: string;
    // Where to go on success.
    readonly next: string;
    readonly title: string;
    readonly working: string;
    // For links that need a signed-in person: where this page lives, so that after signing in the
    // person comes back here and the token (kept in this tab's session storage meanwhile) is spent.
    readonly resume?: { readonly returnTo: string };
}

// Reads a one-time token from the address fragment (`#t=...`), sends it to the API and moves on.
// The fragment is removed from the address bar first, so the secret does not stay in history.
export function FragmentToken({ path, next, title, working, resume }: Props) {
    const [message, setMessage] = useState(working);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const fromAddress = new URLSearchParams(window.location.hash.slice(1)).get("t");
        window.history.replaceState(null, "", window.location.pathname);
        const token = fromAddress ?? takePendingToken();
        if (token === null) {
            setFailed(true);
            setMessage("This link is incomplete. Request a new one.");
            return;
        }
        apiSend(path, result, { method: "POST", body: { token } }).then(
            () => window.location.replace(takeNext(next)),
            (error) => {
                if (resume !== undefined && error instanceof ApiError && error.status === 401) {
                    // Not signed in yet: keep the link for the trip through sign-in, then come back.
                    keepPendingToken(token);
                    rememberNext(resume.returnTo);
                    window.location.replace("/sign-in");
                    return;
                }
                setFailed(true);
                setMessage(messageOf(error));
            },
        );
    }, [path, next, resume]);

    return (
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-12">
            <h1 className="text-2xl font-semibold">{title}</h1>
            <p
                role={failed ? "alert" : "status"}
                aria-live="polite"
                className={failed ? "text-danger" : "text-muted"}
            >
                {message}
            </p>
            {failed && (
                <a className="text-accent underline" href="/sign-in">
                    Back to sign in
                </a>
            )}
        </main>
    );
}

const PENDING_KEY = "aura_pending_token";

// The token waits in this tab's session storage only for the length of one sign-in. It is a one-time
// secret for one invitation and one verified email, and it is removed as soon as it is read.
function keepPendingToken(token: string): void {
    try {
        window.sessionStorage.setItem(PENDING_KEY, token);
    } catch {
        // Without storage the person opens the link again after signing in.
    }
}

function takePendingToken(): string | null {
    try {
        const token = window.sessionStorage.getItem(PENDING_KEY);
        window.sessionStorage.removeItem(PENDING_KEY);
        return token;
    } catch {
        return null;
    }
}
