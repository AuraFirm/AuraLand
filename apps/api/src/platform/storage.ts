import { type Config, s3ClientSettings } from "../config.ts";
import type { Clock } from "./clock.ts";
import type { ObjectStorage } from "./object-storage.ts";
import { createMemoryStorage } from "./storage-memory.ts";
import { createS3Storage } from "./storage-s3.ts";

// Chooses the storage adapter from configuration. parseConfig already refused the in-memory driver
// anywhere but the test environment, so reaching it here means a test asked for it.
export function createStorageFromConfig(config: Config, clock: Clock): ObjectStorage {
    const settings = s3ClientSettings(config);
    return settings === null ? createMemoryStorage(clock) : createS3Storage(settings);
}
