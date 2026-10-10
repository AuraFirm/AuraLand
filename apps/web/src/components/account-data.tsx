"use client";

import { deletionRequestResponseSchema } from "@aura/contracts/api/account";
import { useState } from "react";
import { apiSend, messageOf } from "../lib/api.ts";
import { buttonDanger, buttonQuiet } from "../lib/styles.ts";
import { Notice, Section } from "./section.tsx";

export function AccountData() {
    const [message, setMessage] = useState("");
    const [confirming, setConfirming] = useState(false);

    const requestDeletion = async () => {
        try {
            await apiSend("/me/delete-request", deletionRequestResponseSchema, { method: "POST" });
            window.location.assign("/sign-in");
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };

    return (
        <Section id="data" title="Your data">
            <p className="mb-3 text-muted">
                Download everything we hold about you that you can see, as one file.
            </p>
            <a className={buttonQuiet} href="/api/v1/me/export" download="auraland-export.json">
                Download my data
            </a>
            <h3 className="mb-2 mt-6 font-semibold">Delete my account</h3>
            <p className="mb-3 text-muted">
                This signs you out everywhere and marks your account for deletion. Sign in again
                before the deletion happens to cancel it.
            </p>
            {confirming ? (
                <fieldset className="flex gap-3">
                    <legend className="sr-only">Confirm deletion</legend>
                    <button type="button" className={buttonDanger} onClick={requestDeletion}>
                        Yes, request deletion
                    </button>
                    <button
                        type="button"
                        className={buttonQuiet}
                        onClick={() => setConfirming(false)}
                    >
                        Keep my account
                    </button>
                </fieldset>
            ) : (
                <button type="button" className={buttonDanger} onClick={() => setConfirming(true)}>
                    Delete my account…
                </button>
            )}
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}
