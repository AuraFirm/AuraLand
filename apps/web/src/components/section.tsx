import type { ReactNode } from "react";
import { panel } from "../lib/styles.ts";

// A titled region of a page. The heading names the region for screen readers.
export function Section({
    id,
    title,
    children,
}: {
    id: string;
    title: string;
    children: ReactNode;
}) {
    return (
        <section className={panel} aria-labelledby={`${id}-heading`}>
            <h2 id={`${id}-heading`} className="mb-3 text-lg font-semibold">
                {title}
            </h2>
            {children}
        </section>
    );
}

export function Notice({ text, bad }: { text: string; bad?: boolean }) {
    return (
        <p
            role={bad ? "alert" : "status"}
            aria-live="polite"
            className={bad ? "text-danger" : "text-muted"}
        >
            {text}
        </p>
    );
}
