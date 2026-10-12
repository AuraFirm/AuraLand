import { readFileSync, writeSync } from "node:fs";
import { openAndEncode } from "./open.ts";

// The program a judge node runs in a box (see open.ts): the bundle is on standard input, the stream
// goes to standard output. It is built into one file with tools/build-opener.ts.
const packed = readFileSync(0);
const out = openAndEncode(new Uint8Array(packed.buffer, packed.byteOffset, packed.length));
let written = 0;
// unbounded: not a loop over input; writeSync may write part of a buffer, so continue until all is out.
while (written < out.length) written += writeSync(1, out, written);
