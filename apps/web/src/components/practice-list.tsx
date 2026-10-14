"use client";

import { practiceDailySchema, practiceListSchema } from "@aura/contracts/api/practice";
import { useCallback, useState } from "react";
import { apiGet, messageOf } from "../lib/api.ts";
import { buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// The practice bank: today's pick on top, then the problems newest-listed first, a page at a time.
export function PracticeList() {
    const loadDaily = useCallback(() => apiGet("/practice/daily", practiceDailySchema), []);
    const loadFirst = useCallback(() => apiGet("/practice?limit=20", practiceListSchema), []);
    const daily = useLoad(loadDaily);
    const first = useLoad(loadFirst);
    const [more, setMore] = useState<{ id: string; title: string }[]>([]);
    const [cursor, setCursor] = useState<string | null | undefined>(undefined);
    const [failure, setFailure] = useState("");
    const next = cursor === undefined ? (first.data?.next_cursor ?? null) : cursor;
    const loadMore = async () => {
        if (next === null) return;
        try {
            const page = await apiGet(`/practice?limit=20&cursor=${next}`, practiceListSchema);
            setMore((items) => [...items, ...page.items]);
            setCursor(page.next_cursor);
        } catch (error) {
            setFailure(messageOf(error));
        }
    };
    const items = [...(first.data?.items ?? []), ...more];
    return (
        <>
            {daily.data?.problem != null && (
                <Section id="daily" title={`Today's problem (${daily.data.day})`}>
                    <a
                        className="text-accent underline"
                        href={`/practice/${daily.data.problem.id}`}
                    >
                        {daily.data.problem.title}
                    </a>
                </Section>
            )}
            <Section id="bank" title="Problems">
                {first.error !== "" && <Notice text={first.error} bad />}
                {first.data !== null && items.length === 0 && <Notice text="No problems yet." />}
                <ul className="flex flex-col gap-2">
                    {items.map((item) => (
                        <li key={item.id}>
                            <a className="text-accent underline" href={`/practice/${item.id}`}>
                                {item.title}
                            </a>
                        </li>
                    ))}
                </ul>
                {next !== null && (
                    <button type="button" className={`${buttonQuiet} mt-3`} onClick={loadMore}>
                        Show more
                    </button>
                )}
                {failure !== "" && <Notice text={failure} bad />}
            </Section>
        </>
    );
}
