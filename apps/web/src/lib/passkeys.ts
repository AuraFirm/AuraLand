"use client";

import { passkeyOptionsResponseSchema } from "@aura/contracts/api/passkeys";
import {
    browserSupportsWebAuthn,
    startAuthentication,
    startRegistration,
} from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, apiDo, apiSend } from "./api.ts";

// Passkey ceremonies in the browser. The server issues the options and checks the answer; this file
// only hands the options to the browser's WebAuthn API and sends the result back.

// False on the server and on the first render in the browser, then the real answer, so the server
// and the browser agree on the first render (otherwise React reports a mismatch).
export function usePasskeysSupported(): boolean {
    const [supported, setSupported] = useState(false);
    useEffect(() => setSupported(browserSupportsWebAuthn()), []);
    return supported;
}

const noBody = z.object({}).passthrough();

async function options(path: string) {
    return apiSend(path, passkeyOptionsResponseSchema, { method: "POST", body: {} });
}

export async function registerPasskey(name: string | undefined): Promise<void> {
    const issued = await options("/auth/passkey/register/options");
    // tigerlint-allow: no-as-cast -- the server builds these options with the same library
    const credential = await startRegistration({ optionsJSON: issued.options as never });
    await apiSend("/auth/passkey/register/verify", noBody, {
        method: "POST",
        body: { challenge_id: issued.challenge_id, credential, ...(name ? { name } : {}) },
    });
}

export async function signInWithPasskey(): Promise<void> {
    const issued = await options("/auth/passkey/login/options");
    // tigerlint-allow: no-as-cast -- the server builds these options with the same library
    const credential = await startAuthentication({ optionsJSON: issued.options as never });
    await apiSend("/auth/passkey/login/verify", noBody, {
        method: "POST",
        body: { challenge_id: issued.challenge_id, credential },
    });
}

export async function stepUp(): Promise<void> {
    const issued = await options("/auth/passkey/step-up/options");
    // tigerlint-allow: no-as-cast -- the server builds these options with the same library
    const credential = await startAuthentication({ optionsJSON: issued.options as never });
    await apiDo("/auth/passkey/step-up/verify", {
        method: "POST",
        body: { challenge_id: issued.challenge_id, credential },
    });
}

// Runs a privileged action. If the server says a fresh passkey check is needed, asks for one and
// tries once more.
export async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "step_up_required") throw error;
        await stepUp();
        return action();
    }
}
