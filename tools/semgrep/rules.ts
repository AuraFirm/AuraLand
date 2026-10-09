// Test cases for rules.yml. `ruleid:` marks a line that must be flagged, `ok:` one that must not.
// This folder is excluded from Biome, tigerlint and tsc because it contains deliberately bad code.
import { createHash } from "node:crypto";

declare const db: any;
declare const id: string;
declare const sql: any;

// ruleid: aura-no-unsafe-sql
db.unsafe("select 1");
// ok: aura-no-unsafe-sql
db`select 1`;

// ruleid: aura-no-string-built-sql
const bad = `select * from users where id = ${id}`;
// ruleid: aura-no-string-built-sql
const bad2 = `delete from users where id = ${id}`;
// ok: aura-no-string-built-sql
const good = sql`select * from users where id = ${id}`;
// ok: aura-no-string-built-sql
const plain = `select * from users`;
// ok: aura-no-string-built-sql
const prose = `Selected ${id} items from the list`;

// ruleid: aura-no-eval
eval("1 + 1");
// ruleid: aura-no-eval
new Function("return 1");
// ok: aura-no-eval
const evaluate = (x: number) => x;

// ruleid: aura-no-math-random
const r = Math.random();
// ok: aura-no-math-random
const m = Math.max(1, 2);

// ruleid: aura-no-weak-hash
createHash("md5");
// ruleid: aura-no-weak-hash
createHash("sha1");
// ok: aura-no-weak-hash
createHash("sha256");

// ruleid: aura-no-tls-bypass
const agentOptions = { rejectUnauthorized: false };
// ok: aura-no-tls-bypass
const safeOptions = { rejectUnauthorized: true };

// ruleid: aura-no-direct-http
fetch("https://example.com");
// ok: aura-no-direct-http
const fetchLabel = "fetch";

// ruleid: aura-no-shell-exec
import { exec } from "node:child_process";
// ok: aura-no-shell-exec
import { execFile } from "node:child_process";
// ruleid: aura-no-shell-exec
const options = { shell: true };

// ruleid: aura-no-raw-html
const html = <div dangerouslySetInnerHTML={{ __html: id }} />;
// ok: aura-no-raw-html
const plainDiv = <div>{id}</div>;
