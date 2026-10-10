import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { loadConfigFromProcess, s3ClientSettings } from "./config.ts";

// Usage: pnpm storage:init
// Creates the bucket named in the configuration on the local S3 server. Safe to repeat. Production
// buckets are created by infrastructure, with encryption and lifecycle rules, not by this tool.
const settings = s3ClientSettings(loadConfigFromProcess());
if (settings === null) {
    process.stderr.write("AURA_STORAGE_DRIVER is memory; there is no bucket to create\n");
    process.exit(2);
}
const client = new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
});
try {
    await client.send(new CreateBucketCommand({ Bucket: settings.bucket }));
    process.stdout.write(`created bucket ${settings.bucket}\n`);
} catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
    process.stdout.write(`bucket ${settings.bucket} already exists\n`);
}
