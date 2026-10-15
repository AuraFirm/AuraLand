// Cost per verification (Stage 9, slice 11): usage counts times unit costs. The unit costs are INPUTS someone supplies from a real bill;
// the ones in docs/compliance/unit-costs.json are illustrative placeholders, so every number this produces is illustrative until then.
// No I/O here.

export interface UnitCosts {
    readonly currency: string;
    // Whole minor units of the currency per single event (for example cents per environment run).
    readonly perEvent: Readonly<Record<string, number>>;
    // Fixed cost per month that is shared across all events (hosting, for example), in the same minor units.
    readonly fixedPerMonth: number;
}

export interface CostReport {
    readonly currency: string;
    readonly events: number;
    readonly variableMinor: number;
    readonly fixedMinor: number;
    readonly totalMinor: number;
    // Total divided by events, in minor units with two decimals; null when there were no events (a division by zero is not a cost).
    readonly perEventMinor: number | null;
    readonly unpriced: readonly string[];
}

export function costReport(counts: Readonly<Record<string, number>>, costs: UnitCosts): CostReport {
    let events = 0;
    let variableMinor = 0;
    const unpriced: string[] = [];
    for (const [kind, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
        if (!Number.isInteger(count) || count < 0)
            throw new Error(`a count is a non-negative integer, got ${count} for ${kind}`);
        const unit = costs.perEvent[kind];
        if (unit === undefined) {
            unpriced.push(kind);
            continue;
        }
        if (!Number.isInteger(unit) || unit < 0)
            throw new Error(`a unit cost is a non-negative integer, got ${unit} for ${kind}`);
        events += count;
        variableMinor += count * unit;
    }
    const totalMinor = variableMinor + costs.fixedPerMonth;
    return {
        currency: costs.currency,
        events,
        variableMinor,
        fixedMinor: costs.fixedPerMonth,
        totalMinor,
        perEventMinor: events === 0 ? null : Math.round((totalMinor / events) * 100) / 100,
        unpriced,
    };
}
