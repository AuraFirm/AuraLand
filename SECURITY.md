# Security policy

AuraLand is pre-release (Stage 0: foundations only, nothing is deployed). Reports are still
welcome, and the highest-priority classes are the ones this product exists to prevent.

## Reporting a vulnerability
Please **do not open a public issue**. Report privately through GitHub:
<https://github.com/AuraFirm/AuraLand/security/advisories/new>

Include what you found, how to reproduce it, the affected file or version (commit hash), and the
impact you expect. We aim to acknowledge a report within 5 business days and to keep you informed
until it is resolved. There is no bug bounty yet.

## Priority classes
1. Escaping the code-execution sandbox (when it exists) or reading hidden tests and verifiers.
2. Reading or changing another organization's data (tenant isolation, row-level security).
3. Authentication, session or credential-signing weaknesses.
4. Injection (SQL, HTML, command), server-side request forgery, path traversal.
5. Supply-chain issues in dependencies, build or CI configuration.

## Out of scope
Volumetric denial of service, social engineering, findings in third-party services, and issues that
need physical access to a machine.

## Our own checks
Dependencies are pinned and gated by a release-age rule; CI runs Semgrep with project rules,
CodeQL, secret scanning and Trivy container scans. See `docs/threat-model.md` and `docs/adr/`.
