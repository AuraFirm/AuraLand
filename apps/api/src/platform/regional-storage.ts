import { DATA_REGIONS } from "@aura/contracts/api/orgs";
import { assert } from "@aura/contracts/assert";
import type { ObjectStorage } from "./object-storage.ts";

// Data residency for stored objects (Stage 9, ADR 0038): an organization's `data_region` decides which storage its files live in.
// The rule that matters is the failure mode: a region with no storage of its own is an ERROR, never a quiet fall-back to another region,
// because "your data stays in the EU" must not turn into "your data stayed in the EU unless we forgot to configure Asia".

export type DataRegion = (typeof DATA_REGIONS)[number];

export class RegionNotConfiguredError extends Error {
    override readonly name = "RegionNotConfiguredError";
}

export interface RegionalStorage {
    // The storage for an organization's region; throws RegionNotConfiguredError when there is none.
    forRegion(region: string): ObjectStorage;
    // The regions this deployment can serve.
    readonly regions: readonly DataRegion[];
}

export function createRegionalStorage(
    byRegion: Readonly<Partial<Record<DataRegion, ObjectStorage>>>,
): RegionalStorage {
    const regions = DATA_REGIONS.filter((region) => byRegion[region] !== undefined);
    assert(regions.length > 0, "at least one region has storage");
    return {
        regions,
        forRegion(region) {
            const known = DATA_REGIONS.find((candidate) => candidate === region);
            const storage = known === undefined ? undefined : byRegion[known];
            if (storage === undefined)
                throw new RegionNotConfiguredError(`no storage is configured for region ${region}`);
            return storage;
        },
    };
}
