// The comparison at the heart of the disaster-recovery drill (no I/O): after a database is dumped and restored somewhere else, every
// table must hold the same number of rows, and nothing may be missing or extra. Counts are cheap and catch the failures that
// matter in a restore (a table that did not come back, rows lost to an error that was swallowed); the audit chain check in the
// drill covers tampering and truncation of the one table where order and content matter most.

export type TableCounts = Readonly<Record<string, number>>;

export function compareCounts(source: TableCounts, restored: TableCounts): string[] {
    const problems: string[] = [];
    for (const table of Object.keys(source).sort()) {
        const before = source[table];
        const after = restored[table];
        if (after === undefined) problems.push(`${table}: missing after restore`);
        else if (before !== after) problems.push(`${table}: ${before} rows before, ${after} after`);
    }
    for (const table of Object.keys(restored).sort()) {
        if (!(table in source)) problems.push(`${table}: appeared only in the restore`);
    }
    return problems;
}
