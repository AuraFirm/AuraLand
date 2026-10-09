import { fileURLToPath } from "node:url";
import { createDatabase } from "./client.ts";
import { loadMigrations, migrate } from "./migrate.ts";

const url = process.env["AURA_DATABASE_URL"];
if (url === undefined) {
    throw new Error("AURA_DATABASE_URL is required to run migrations");
}
const directory = fileURLToPath(new URL("../migrations", import.meta.url));
const database = createDatabase(url, 1);
try {
    const applied = await migrate(database.sql, loadMigrations(directory));
    process.stdout.write(`Applied ${applied.length} migration(s): ${applied.join(", ")}\n`);
} finally {
    await database.close(5);
}
