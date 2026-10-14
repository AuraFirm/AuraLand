import { readFileSync, writeSync } from "node:fs";
import { runRewrite } from "./rewrite.ts";

// The program a judge node runs in a box to write a delivery's watermark into a bundle (see
// rewrite.ts). Built into one file with tools/build-opener.ts.
const input = readFileSync(0);
const out = runRewrite(new Uint8Array(input.buffer, input.byteOffset, input.length));
let written = 0;
// unbounded: not a loop over input; writeSync may write part of a buffer, so continue until all is out.
while (written < out.length) written += writeSync(1, out, written);
