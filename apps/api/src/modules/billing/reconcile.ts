import { assert } from "@aura/contracts/assert";

// Reconciliation (no I/O): compare what we counted with what the payment provider says it was told. The two lists are keyed by
// (organization, kind); every key lands in exactly one of four buckets, and any bucket but "matched" is a difference a person
// must look at. A difference is never repaired automatically.

export type UsageKind = "env_run" | "employer_report";
export interface UsageLine {
    readonly org: string;
    readonly kind: UsageKind;
    readonly count: number;
}

export type Difference =
    | {
          readonly type: "missing_at_provider";
          readonly org: string;
          readonly kind: UsageKind;
          readonly ours: number;
      }
    | {
          readonly type: "unknown_at_provider";
          readonly org: string;
          readonly kind: UsageKind;
          readonly theirs: number;
      }
    | {
          readonly type: "count_mismatch";
          readonly org: string;
          readonly kind: UsageKind;
          readonly ours: number;
          readonly theirs: number;
      };

const keyOf = (line: UsageLine) => `${line.org}|${line.kind}`;

function index(lines: readonly UsageLine[]): Map<string, UsageLine> {
    const map = new Map<string, UsageLine>();
    for (const line of lines) {
        assert(
            Number.isInteger(line.count) && line.count >= 0,
            "a count is a non-negative integer",
        );
        assert(!map.has(keyOf(line)), "a list has one line per organization and kind");
        map.set(keyOf(line), line);
    }
    // A zero count is the same as no line; it was validated above, so only now is it dropped.
    for (const [key, line] of map) {
        if (line.count === 0) map.delete(key);
    }
    return map;
}

// Lines with a count of zero are the same as no line, on either side.
export function reconcile(ours: readonly UsageLine[], theirs: readonly UsageLine[]): Difference[] {
    const mine = index(ours);
    const yours = index(theirs);
    const differences: Difference[] = [];
    for (const [key, line] of mine) {
        const other = yours.get(key);
        if (other === undefined)
            differences.push({
                type: "missing_at_provider",
                org: line.org,
                kind: line.kind,
                ours: line.count,
            });
        else if (other.count !== line.count)
            differences.push({
                type: "count_mismatch",
                org: line.org,
                kind: line.kind,
                ours: line.count,
                theirs: other.count,
            });
    }
    for (const [key, line] of yours) {
        if (!mine.has(key))
            differences.push({
                type: "unknown_at_provider",
                org: line.org,
                kind: line.kind,
                theirs: line.count,
            });
    }
    return differences.sort((a, b) =>
        `${a.org}|${a.kind}|${a.type}`.localeCompare(`${b.org}|${b.kind}|${b.type}`),
    );
}
