"use client";

import { BUNDLE_BYTES_MAX } from "@aura/contracts/limits";
import { type FormEvent, useRef, useState } from "react";
import { messageOf } from "../lib/api.ts";
import { button } from "../lib/styles.ts";
import { uploadBundle } from "../lib/upload.ts";
import { Notice, Section } from "./section.tsx";

// Picks a bundle file and sends it straight to storage, part by part. The page never shows more than
// a status line: the API checks the size and hash before it records anything.
export function VersionBundle({ versionId, onDone }: { versionId: string; onDone: () => void }) {
    const file = useRef<HTMLInputElement>(null);
    const [status, setStatus] = useState("");
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);

    const send = async (event: FormEvent) => {
        event.preventDefault();
        const chosen = file.current?.files?.[0];
        if (chosen === undefined) {
            setFailed(true);
            setStatus("Choose a bundle file first.");
            return;
        }
        if (chosen.size > BUNDLE_BYTES_MAX) {
            setFailed(true);
            setStatus(`The file is larger than ${BUNDLE_BYTES_MAX / (1024 * 1024)} MiB.`);
            return;
        }
        setBusy(true);
        try {
            await uploadBundle(versionId, chosen, (text) => {
                setFailed(false);
                setStatus(text);
            });
            setStatus("Bundle uploaded and verified.");
            onDone();
        } catch (error) {
            setFailed(true);
            setStatus(messageOf(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section id="bundle" title="Bundle">
            <form onSubmit={send} className="flex flex-col gap-2">
                <label htmlFor="bundle-file">Bundle file (.tar.zst, up to 64 MiB)</label>
                <input id="bundle-file" ref={file} type="file" disabled={busy} />
                <button type="submit" className={button} disabled={busy}>
                    Upload bundle
                </button>
            </form>
            {status !== "" && <Notice text={status} bad={failed} />}
        </Section>
    );
}
