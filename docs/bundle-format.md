# Task bundle format v1 (as the ingest validator accepts it)

Source of truth for what `packages/bundle` accepts. It narrows `docs/kit/07` section 7 to one
canonical form so that two bundles with the same files are the same bytes. Anything else is refused
with a specific code (`packages/bundle/src/errors.ts`). The corpus in `packages/bundle/corpus/` holds
one file per rule and is the conformance test for any other implementation.

## Container
A bundle is a **zstd-compressed canonical tar**. Limits (all in `@aura/contracts/limits`):
- packed size at most 64 MiB in Stage 2 (the kit's 512 MiB waits for the worker); unpacked at most
  256 MiB;
- unpacked size at most 100 times the packed size, **except** that anything up to 5 MiB unpacked is
  always allowed (5,000 small files compress better than 100:1 because their headers repeat);
- at most 5,000 entries; one file at most 64 MiB.

## Canonical tar
ustar, regular files only (no directories, links, devices, extended headers). Every header must be
**byte-identical** to the one our writer produces for that name and size: mode `0000644`, uid and gid
0, no owner or group names, modification time 0, no link name, no prefix, magic `ustar\0`, version
`00`, checksum in the `NNNNNN\0 ` form. Data is padded with zero bytes to 512, the archive ends with
exactly two zero blocks and nothing after. Entries are in byte order of their paths, paths unique
also ignoring letter case.

## Paths
Relative, `/`-separated, at most 100 bytes, at most 4 segments of at most 64 bytes each, every
segment matching `[A-Za-z0-9][A-Za-z0-9._-]*`. That one allowlist excludes absolute paths, `.` and
`..`, empty segments, hidden files, backslashes, NUL, control characters, spaces, non-ASCII and a
trailing slash.

## Layout
| Path | Rule |
|---|---|
| `task.json` | required; UTF-8 JSON (no byte-order mark) up to 256 KiB; must be a valid `TaskSpec` (`@aura/contracts/tasks`) |
| `statement/en.md` | required; UTF-8, 1 byte to 64 KiB. Other `statement/<xx>.md` allowed. No `statement/assets/` yet |
| `tests/<id>.in`, `tests/<id>.ans` | exactly one pair for every test in the spec, nothing else under `tests/` |
| `checker/checker.cpp` or `checker.py` | required exactly once when the spec's checker is `custom`, forbidden otherwise |
| `samples/*`, `solutions/*`, `generators/*`, `validator/*` | optional, one level, free-form |
| anything else (including `env/`) | refused |

## Result
On success: the spec, the statement text, every file's path, size and SHA-256, and the SHA-256 of the
unpacked tar (the kit's content address, which the sandbox records in Stage 3). Error details name a
path or field and never quote contents.

## Not yet checked (Stage 3, in the sandbox)
That the validator program accepts every test, that the reference solution passes, that the statement
in the bundle equals the one stored in the database, and anything that needs running code.
