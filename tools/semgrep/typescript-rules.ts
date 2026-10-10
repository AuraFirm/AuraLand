// Test cases for typescript-rules.yml. `ruleid:` marks a line that must be flagged, `ok:` one
// that must not. This folder is excluded from Biome, tigerlint and tsc: it contains bad code on
// purpose.
import { createHash } from "node:crypto";

declare const db: any;

// ruleid: aura-no-unsafe-sql
db.unsafe("select 1");
// ok: aura-no-unsafe-sql
db.query("select 1");

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

// ruleid: aura-no-direct-http
fetch("https://example.com");
// ok: aura-no-direct-http
const fetchLabel = "fetch";

declare const element: any;
declare const htmlText: string;

// ruleid: aura-no-raw-html-sink
element.innerHTML = htmlText;
// ruleid: aura-no-raw-html-sink
element.outerHTML = htmlText;
// ruleid: aura-no-raw-html-sink
element.insertAdjacentHTML("beforeend", htmlText);
// ruleid: aura-no-raw-html-sink
document.write(htmlText);
// ok: aura-no-raw-html-sink
element.textContent = htmlText;
