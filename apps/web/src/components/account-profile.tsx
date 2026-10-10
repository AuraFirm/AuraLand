"use client";

import { meResponseSchema } from "@aura/contracts/api/identity";
import { useCallback, useState } from "react";
import { apiDo, apiGet, messageOf } from "../lib/api.ts";
import { buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

export function AccountProfile() {
    const load = useCallback(() => apiGet("/me", meResponseSchema), []);
    const { data, error, reload } = useLoad(load);
    const [message, setMessage] = useState("");

    const cancelDeletion = async () => {
        try {
            await apiDo("/me/delete-request", { method: "DELETE" });
            reload();
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };

    return (
        <Section id="profile" title="Your account">
            {error !== "" && <Notice text={error} bad />}
            {data !== null && (
                <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted">Email</dt>
                    <dd>{data.email}</dd>
                    <dt className="text-muted">Handle</dt>
                    <dd>{data.handle ?? "—"}</dd>
                    <dt className="text-muted">Name</dt>
                    <dd>{data.display_name ?? "—"}</dd>
                </dl>
            )}
            {data?.deletion_requested_at != null && (
                <div className="mb-3 flex flex-wrap items-center gap-3">
                    <Notice
                        text={`Deletion requested on ${new Date(data.deletion_requested_at).toLocaleString()}.`}
                        bad
                    />
                    <button type="button" className={buttonQuiet} onClick={cancelDeletion}>
                        Cancel deletion
                    </button>
                </div>
            )}
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}
