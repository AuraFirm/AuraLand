"use client";

import { deliveriesResponseSchema } from "@aura/contracts/api/deliveries";
import { apiGet } from "../lib/api.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

const load = () => apiGet("/deliveries", deliveriesResponseSchema);

// The deliveries of the signed-in person's organizations, newest first. Which ones appear is decided by
// the API and PostgreSQL; this list only shows what came back.
export function DeliveriesList() {
    const { data, error } = useLoad(load);
    return (
        <Section id="deliveries" title="Your deliveries">
            {error !== "" && <Notice text={error} bad />}
            {data !== null && data.deliveries.length === 0 && (
                <Notice text="Nothing has been delivered to your organizations yet." />
            )}
            <ul className="flex flex-col gap-2">
                {data?.deliveries.map((delivery) => (
                    <li
                        key={delivery.id}
                        className="flex items-center justify-between gap-3 border-b border-line pb-2"
                    >
                        <a className="text-accent underline" href={`/deliveries/${delivery.id}`}>
                            {delivery.order_title}
                        </a>
                        <span className="text-sm text-muted">
                            {delivery.status} · until {delivery.expires_at.slice(0, 10)}
                        </span>
                    </li>
                ))}
            </ul>
        </Section>
    );
}
