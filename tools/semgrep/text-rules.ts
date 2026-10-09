// Test cases for text-rules.yml (see typescript-rules.ts for the annotation format).
declare const id: string;
declare const sql: any;

// ruleid: aura-no-string-built-sql
const bad = `select * from users where id = ${id}`;
// ruleid: aura-no-string-built-sql
const bad2 = `delete from users where id = ${id}`;
// ok: aura-no-string-built-sql
const good = sql`select * from users where id = ${id}`;
// ok: aura-no-string-built-sql
const typed = sql<{ n: number }[]>`select n from users where id = ${id}`;
// ok: aura-no-string-built-sql
const plain = `select * from users`;
// ok: aura-no-string-built-sql
const prose = `Selected ${id} items from the list`;

// ruleid: aura-no-tls-bypass
const agentOptions = { rejectUnauthorized: false };
// ok: aura-no-tls-bypass
const safeOptions = { rejectUnauthorized: true };

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
