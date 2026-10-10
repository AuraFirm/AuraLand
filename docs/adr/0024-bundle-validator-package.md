# 0024 — The bundle ingest validator is a new package, `packages/bundle`
Status: accepted
Date: 2026-10-11

## Context
The kit requires an ingest validator for task bundles that is "fuzzed code" and "runs inside a
sandbox, never on the API host" (docs/kit/07 section 7, docs/kit/08 section 4). Stage 2 builds it as a
library and exercises it with a corpus and fuzzing; Stage 3 runs it where untrusted archives may be
parsed. A new top-level folder needs an ADR (CLAUDE.md).

## Decision
- **`packages/bundle`**: a pure function from bytes to a verified description or one of 20 refusal
  codes. It imports only `@aura/contracts` and `node:zlib` / `node:crypto`; tigerlint refuses `node:fs`,
  network, process and other workspace imports in it (tests and the `-cli.ts` tools may read files).
- **One canonical tar form**, not a lenient reader. The reader accepts exactly what our writer
  produces (byte-identical headers), which turns a long list of tar quirks into one comparison. See
  `docs/bundle-format.md`.
- **No new dependencies.** Node 24's `zlib` has zstd with an output cap; the tar reader and writer are
  about 150 lines. The plan listed `fast-check` for fuzzing; a 70-line seeded mutation fuzzer does the
  job without a dependency, so it is not added.
- **Language-neutral corpus** in `packages/bundle/corpus/`: one file per rule plus
  `expectations.json`. A test regenerates the cases and compares the unpacked bytes (zstd output may
  differ between library versions), and another checks that every refusal code is covered. The Go
  port, if Stage 3 wants one, must pass the same files.
- **Fuzzing**: 3,000 mutated bundles per test run, 200,000 per night (`fuzz-cli.ts`), with checksum
  repair so mutations reach the checks behind the checksum.
- **The ratio rule has a 5 MiB floor** because 5,000 small files legitimately compress better than
  100:1. The corpus found this: a bundle with the maximum entry count tripped the rule.

## Known gaps
The refusal for an unpacked size over 256 MiB with a packed size above 2.6 MiB has no corpus file
(it needs a large incompressible-looking input); the logic is two lines and shares its path with the
ratio rule. The validator trusts `zstdDecompressSync`'s output cap; a zstd library bug would be a
library bug, and Stage 3 runs the validator in a memory-limited sandbox anyway.

## Alternatives considered
A lenient tar reader plus per-quirk checks (long tail of quirks); a third-party tar package (a larger
attack surface than 150 lines we can fuzz); hashing the tar on the API host (forbidden, ADR 0022).
