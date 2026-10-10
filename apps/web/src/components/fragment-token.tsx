"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, apiSend, messageOf } from "../lib/api.ts";

const result = z.object({ status: z.string() }).passthrough();

interface Props {
    // The API route that spends the token.
    readonly path: string;
    // Where to go on success.
    readonly next: string;
    readonly title: string;
    readonly working: string;
    // Shown instead of the error when the person is not signed in.
    readonly signInHint?: string;
}

// Reads a one-time token from the address fragment (`#t=...`), sends it to the API and moves on.
// The fragment is removed from the address bar first, so the secret does not stay in history.
export function FragmentToken({ path, next, title, working, signInHint }: Props) {
    const [message, setMessage] = useState(working);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
        window.history.replaceState(null, "", window.location.pathname);
        if (token === null) {
            setFailed(true);
            setMessage("This link is incomplete. Request a new one.");
            return;
        }
        apiSend(path, result, { method: "POST", body: { token } }).then(
            () => window.location.replace(next),
            (error) => {
                setFailed(true);
                const signedOut = error instanceof ApiError && error.status === 401;
                setMessage(signedOut && signInHint !== undefined ? signInHint : messageOf(error));
            },
        );
    }, [path, next, signInHint]);

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
