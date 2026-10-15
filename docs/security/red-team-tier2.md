# Red-team checklist and findings: Tier-2 (gVisor)

A checklist for a human attacker or reviewer, and a table that records what was found. Not a tool. **No external person has used it
yet (F73).** Findings made by the builders while writing tests are listed too, marked as such.

## Checklist (each item: try it, write what happened)
**Escape**: syscalls gVisor leaves open on this kernel and version; `/proc`, `/sys` and `/dev` contents; ptrace and signals toward
host processes; mounts, `chroot`, `pivot_root`; user namespaces; abusing `runsc-gofer` file operations; races between the node's
copy-in/copy-out and the agent (symlink swaps while `cp -a` runs); anything reachable through the memory-file-system workspace.
**Resource**: fork bombs, memory hogs, disk and inode floods, output floods, many small files, deep directory trees, huge sparse
files, anything that makes the node's copy-out slow or large, many runs at once against one node's memory (F74).
**Network**: any interface other than loopback; DNS; abstract sockets; unix sockets on host paths; metadata addresses.
**Reward hacking**: reading or guessing hidden material, the verifier, canaries; editing the check, its config or its inputs;
links to hidden files; detecting the harness and behaving differently; writing to the workspace after the last step; exploiting the
snapshot or the pristine restore; printing a canary to the output; making the trace lie (it holds hashes only).
**Supply**: a malicious image archive (hard links, symlink chains, names with `..`, huge entry counts, sparse files, setuid files,
device nodes) and a malicious hidden archive; a presigned URL that points elsewhere; a hash collision attempt (SHA-256).
**Control plane**: a forged trace, a replayed trace, a trace for another run or from another node, a node that lies about
`isolation`, an environment whose spec asks for more than limits allow, a non-author reading another organization's runs or
leaderboard.
**After**: leftover processes, mounts, cgroups, directories, files owned by the agent's user (see the drill).

## Findings (builders, 2026-10-15; all on one development VM)
| # | Found by | What | Status |
|---|---|---|---|
| 1 | Escape suite, `disk_fill` | A per-file size limit does not bound total disk use | Fixed: workspace is a memory file system of exactly the disk limit |
| 2 | Verifier test | A symlink from `answer.txt` to the hidden expected file is graded against the verifier's own copy and scores 1 | Fixed: snapshots drop links and report them (`link_in_workspace`) |
| 3 | Hack environment | Our own hashing looked like the agent reading the honeypot (access times) | Fixed: epoch access time on copy-in, `O_NOATIME` when we read |
| 4 | End-to-end run | Real images contain hard links; the unpacker refused them | Fixed: copied from an already unpacked regular file, never linked; escapes still refused |
| 5 | End-to-end run | An unprivileged node cannot chown host files to the agent's user | Fixed: chown happens on the in-memory copy, files are handed back to the node's user |
| 6 | Drill | A sandbox and cgroup from an earlier killed test run were still alive 90 minutes later; no startup sweep exists | Fixed: the node sweeps stale sandboxes at startup (`SweepStale`, tested on the VM) |
| 7 | Drill | 49 defunct `runsc-fd-parking` children of the VM's init, never reaped | Not reproduced after the VM was restarted (none after a day of heavy runs); the VM was in a hung state when they appeared. Re-check on a real node (F71) |
| 8 | Design | The unpacker ran in the node agent's process, not in a sandbox | Fixed (F70): unpacked inside gVisor by default; the in-process way remains as an explicit, documented opt-out |
| 9 | Design | The workspace's bytes are charged to the node, not to the sandbox's cgroup | **Open (F74)**: no admission control by memory |

## Not tried
Kernel-surface fuzzing, side channels, x86, other gVisor platforms, concurrent hostile runs against each other, a hostile image built
to crash `runsc` itself, anything needing a second machine. Any claim of "secure" is premature until F73.
