"use client";

import { contestsResponseSchema } from "@aura/contracts/api/contests";
import { useCallback } from "react";
import { apiGet } from "../lib/api.ts";
import { showInstant, stateWords } from "../lib/contest-time.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// Published public contests, newest first. Anyone may read it, signed in or not.
export function ContestsList({ query = "" }: { query?: string }) {
    const load = useCallback(
        () => apiGet(`/contests?limit=30${query}`, contestsResponseSchema),
        [query],
    );
    const { data, error } = useLoad(load);
    return (
        <Section id="contests" title="Contests">
            {error !== "" && <Notice text={error} bad />}
            {data !== null && data.contests.length === 0 && <Notice text="No contests yet." />}
            <ul className="flex flex-col gap-3">
                {data?.contests.map((contest) => (
                    <li key={contest.id} className="border-b border-line pb-3">
                        <a className="text-accent underline" href={`/arena/contests/${contest.id}`}>
                            {contest.title}
                        </a>
                        <p className="text-sm text-muted">
                            {contest.format.toUpperCase()}
                            {contest.rated ? " · rated" : ""} · {stateWords(contest.state)}
                        </p>
                        <p className="text-sm text-muted">{showInstant(contest.starts_at)}</p>
                    </li>
                ))}
            </ul>
        </Section>
    );
}
