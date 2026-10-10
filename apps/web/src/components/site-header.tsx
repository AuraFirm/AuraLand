"use client";

import { sessionStatusSchema } from "@aura/contracts/api/account";
import { useEffect, useState } from "react";
import { apiDo, apiGet } from "../lib/api.ts";
import { buttonQuiet } from "../lib/styles.ts";

// Navigation on every page. Signing out is always one click away (ASVS V7.4.4). Whether the person
// is signed in is asked of the API; nothing here decides anything about access.
export function SiteHeader() {
    const [signedIn, setSignedIn] = useState<boolean | null>(null);

    useEffect(() => {
        apiGet("/me/status", sessionStatusSchema).then(
            (status) => setSignedIn(status.signed_in),
            () => setSignedIn(false),
        );
    }, []);

    const signOut = async () => {
        await apiDo("/auth/logout", { method: "POST" }).catch(() => undefined);
        window.location.assign("/");
    };

    return (
        <header className="border-b border-line">
            <nav aria-label="Main" className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3">
                <a className="font-semibold" href="/">
                    Aura<span className="text-accent">Land</span>
                </a>
                {signedIn === true && (
                    <>
                        <a className="text-accent underline" href="/account">
                            Account
                        </a>
                        <a className="text-accent underline" href="/orgs">
                            Organizations
                        </a>
                        <button
                            type="button"
                            className={`${buttonQuiet} ml-auto`}
                            onClick={signOut}
                        >
                            Sign out
                        </button>
                    </>
                )}
                {signedIn === false && (
                    <a className="ml-auto text-accent underline" href="/sign-in">
                        Sign in
                    </a>
                )}
            </nav>
        </header>
    );
}
