"use client";

import { publicProfileSchema, ratingHistorySchema } from "@aura/contracts/api/ratings";
import { useCallback } from "react";
import { apiGet } from "../lib/api.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// A public profile: the name, the rating with its tier and the rating history. The tier's name is always
// written out; its color is a decoration beside it and carries no meaning of its own.
const DOT_COLORS: Readonly<Record<string, string>> = {
    gray: "#6b7280",
    green: "#15803d",
    teal: "#0f766e",
    blue: "#1d4ed8",
    violet: "#7e22ce",
    orange: "#c2410c",
    red: "#b91c1c",
};

export function ProfileView({ handle }: { handle: string }) {
    const loadProfile = useCallback(
        () => apiGet(`/users/${encodeURIComponent(handle)}`, publicProfileSchema),
        [handle],
    );
    const loadHistory = useCallback(
        () => apiGet(`/users/${encodeURIComponent(handle)}/ratings?limit=50`, ratingHistorySchema),
        [handle],
    );
    const profile = useLoad(loadProfile);
    const history = useLoad(loadHistory);
    if (profile.error !== "") return <Notice text="No such profile." bad />;
    if (profile.data === null) return <h1 className="text-2xl font-semibold">Profile</h1>;
    const { rating } = profile.data;
    return (
        <>
            <h1 className="text-2xl font-semibold">{profile.data.display_name}</h1>
            <p className="text-muted">@{profile.data.handle}</p>
            <Section id="rating" title="Rating">
                {rating === null ? (
                    <p>Not rated yet: no rated contest finished.</p>
                ) : (
                    <p>
                        <span
                            aria-hidden="true"
                            className="mr-2 inline-block h-3 w-3 rounded-full"
                            style={{ backgroundColor: DOT_COLORS[rating.color] ?? "#6b7280" }}
                        />
                        <strong>{rating.rating}</strong> · {rating.tier} · {rating.contests}{" "}
                        {rating.contests === 1 ? "contest" : "contests"}
                        {rating.provisional ? " · still settling" : ""}
                    </p>
                )}
            </Section>
            <Section id="history" title="Rating history">
                {history.data !== null && history.data.items.length === 0 && (
                    <Notice text="No rated contests yet." />
                )}
                <ul className="flex flex-col gap-2">
                    {history.data?.items.map((item) => (
                        <li key={item.contest_id} className="border-b border-line pb-2">
                            <a
                                className="text-accent underline"
                                href={`/arena/contests/${item.contest_id}`}
                            >
                                {item.contest_title}
                            </a>
                            <p className="text-sm text-muted">
                                Rank {item.rank} · {item.rating_before} → {item.rating_after} (
                                {item.change >= 0 ? "+" : ""}
                                {item.change})
                            </p>
                        </li>
                    ))}
                </ul>
            </Section>
        </>
    );
}
