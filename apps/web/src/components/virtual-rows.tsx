"use client";

import { type ReactNode, useState } from "react";

// Shows only the rows near the viewport of a scrolling box, so a board of ten thousand people costs a
// few dozen elements. Rows have one fixed height, which keeps the arithmetic exact. The full row count is
// told to assistive technology (aria-rowcount / aria-rowindex), so a screen reader knows the real size.
const OVERSCAN_ROWS = 5;

export function VirtualRows<T>({
    items,
    rowHeightPx,
    viewportHeightPx,
    label,
    header,
    renderRow,
}: {
    items: readonly T[];
    rowHeightPx: number;
    viewportHeightPx: number;
    label: string;
    header: ReactNode;
    renderRow: (item: T, index: number) => ReactNode;
}) {
    const [scrollTopPx, setScrollTopPx] = useState(0);
    const first = Math.max(0, Math.floor(scrollTopPx / rowHeightPx) - OVERSCAN_ROWS);
    const visible = Math.ceil(viewportHeightPx / rowHeightPx) + 2 * OVERSCAN_ROWS;
    const last = Math.min(items.length, first + visible);
    return (
        <section
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
            tabIndex={0}
            aria-label={label}
            className="overflow-auto rounded-[var(--radius-l)] border border-line"
            style={{ height: viewportHeightPx }}
            onScroll={(event) => setScrollTopPx(event.currentTarget.scrollTop)}
        >
            <table className="w-full border-collapse text-sm" aria-rowcount={items.length + 1}>
                <thead className="sticky top-0 bg-panel">{header}</thead>
                <tbody>
                    {first > 0 && (
                        <tr style={{ height: first * rowHeightPx }}>
                            <td />
                        </tr>
                    )}
                    {items
                        .slice(first, last)
                        .map((item, offset) => renderRow(item, first + offset))}
                    {last < items.length && (
                        <tr style={{ height: (items.length - last) * rowHeightPx }}>
                            <td />
                        </tr>
                    )}
                </tbody>
            </table>
        </section>
    );
}
