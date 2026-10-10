"use client";

import { revokedSessionsSchema } from "@aura/contracts/api/account";
import { useState } from "react";
import { apiSend, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { buttonQuiet } from "../lib/styles.ts";
import { Notice } from "./section.tsx";

// Shown right after someone removes a passkey or disconnects a sign-in provider: if that was because
// a device or account was lost, other devices may still be signed in. One click ends them.
export function OtherDevicesPrompt() {
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const signOutOthers = async () => {
        try {
            const result = await withStepUp(() =>
                apiSend("/me/sessions/revoke-others", revokedSessionsSchema, { method: "POST" }),
            );
            setFailed(false);
            setMessage(
                result.revoked === 0
                    ? "No other devices were signed in."
                    : `Signed out ${result.revoked} other ${result.revoked === 1 ? "device" : "devices"}.`,
            );
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };

    return (
        <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-muted">Lost a device? Sign out everything else.</span>
            <button type="button" className={buttonQuiet} onClick={signOutOthers}>
                Sign out my other devices
            </button>
            {message !== "" && <Notice text={message} bad={failed} />}
        </div>
    );
}
