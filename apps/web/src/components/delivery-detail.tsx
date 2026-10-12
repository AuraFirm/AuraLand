"use client";

import { type DeliveryBody, deliverySchema, downloadSchema } from "@aura/contracts/api/deliveries";
import { useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

const STATUS_TEXT: Record<DeliveryBody["status"], string> = {
    pending: "Being prepared. Reload in a moment.",
    ready: "Ready to download.",
    revoked: "Revoked. It can no longer be downloaded.",
    expired: "Expired. It can no longer be downloaded.",
};

export function DeliveryDetail({ deliveryId }: { deliveryId: string }) {
    const load = useCallback(
        () => apiGet(`/deliveries/${deliveryId}`, deliverySchema),
        [deliveryId],
    );
    const { data, error } = useLoad(load);
    if (error !== "") return <Notice text={error} bad />;
    if (data === null) return <h1 className="text-2xl font-semibold">Delivery</h1>;
    return (
        <>
            <h1 className="text-2xl font-semibold">{data.order_title}</h1>
            <p className="text-muted">
                {STATUS_TEXT[data.status]} Available until {data.expires_at.slice(0, 10)}.
            </p>
            {data.status === "ready" && <Items delivery={data} />}
            {data.manifest !== null && <Verification delivery={data} />}
            <a className="text-accent underline" href="/deliveries">
                All deliveries
            </a>
        </>
    );
}

function Items({ delivery }: { delivery: DeliveryBody }) {
    const [message, setMessage] = useState("");
    const download = async (versionId: string) => {
        try {
            const link = await apiSend(`/deliveries/${delivery.id}/downloads`, downloadSchema, {
                method: "POST",
                body: { task_version_id: versionId },
            });
            setMessage("");
            // The link is a short-lived attachment URL; the browser saves the file.
            window.location.assign(link.url);
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };
    return (
        <Section id="items" title="Tasks in this delivery">
            <ul className="flex flex-col gap-3">
                {delivery.items?.map((item) => (
                    <li key={item.task_version_id} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">{item.title}</span>
                            <button
                                type="button"
                                className={buttonQuiet}
                                onClick={() => download(item.task_version_id)}
                            >
                                {`Download ${item.title}`}
                            </button>
                        </div>
                        <span className="text-sm text-muted">
                            {item.bundle_bytes} bytes · validation: {item.validation}
                        </span>
                    </li>
                ))}
            </ul>
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}

function Verification({ delivery }: { delivery: DeliveryBody }) {
    const manifestUrl = () =>
        URL.createObjectURL(new Blob([delivery.manifest ?? ""], { type: "application/json" }));
    const saveManifest = () => {
        const link = document.createElement("a");
        link.href = manifestUrl();
        link.download = "manifest.json";
        link.click();
        URL.revokeObjectURL(link.href);
    };
    return (
        <Section id="verify" title="Check what you received">
            <p className="mb-2 text-sm">
                The manifest lists every file with its SHA-256. Its own hash is:
            </p>
            <code className="mb-3 block break-all text-sm">{delivery.manifest_sha256}</code>
            <button type="button" className={buttonQuiet} onClick={saveManifest}>
                Save the manifest
            </button>
            <p className="mt-3 text-sm text-muted">
                On your machine, <code>shasum -a 256 manifest.json</code> must print the hash above,
                and <code>shasum -a 256</code> of each downloaded file must match the hash listed
                for it.
            </p>
        </Section>
    );
}
