# 0023 — Task tables: what the database enforces
Status: accepted
Date: 2026-10-10

## Context
Stage 2 slice 1 adds `tasks`, `task_versions`, `task_reviews` and `bundle_uploads` (migration 0012).
The plan listed the rules; this record fixes where each lives and three places where the schema
differs from the kit's sketch (docs/kit/05).

## Decision
- **Every rule that must never break is a trigger, constraint or policy**, not only application code:
  allowed state pairs, the frozen released version, one released and one validating version per task,
  creator never reviews or releases, an approving review before release, waived exactly when validation
  was skipped, gapless numbering, and the caps. The application state machine (slice 2) encodes the
  same pairs and a test will compare the two lists.
- **No stored bundle key.** The key is `bundles/<org_id>/<sha256 hex>`, computed from two columns that
  already exist, so a hidden column cannot leak and two sources of truth cannot disagree. The kit's
  "hidden bundle key" requirement is met by never storing it.
- **No `current_version_id` pointer.** The current version is the one released version of a task, and
  a partial unique index makes "at most one" a database fact. Releasing a newer version means retiring
  the old one first, in the same transaction. This removes a circular reference and a way for the
  pointer to disagree with the states.
- **Visibility:** content roles (owner, admin, setter, reviewer) read all of their organization's task
  data; plain members read tasks of visibility `org` and the released versions of those. Known
  limitation: such members also see the titles of `org` tasks that have no released version yet
  (hiding them would make the tasks and versions policies refer to each other, which PostgreSQL
  rejects as recursion). Use `private` while drafting.
- **Guard functions are `SECURITY DEFINER`** (with a fixed search path) so counts and numbering do not
  depend on which rows the caller's row-level security shows. The membership-role check gains
  `setter` and `reviewer`; invitations and the role-change contracts follow with the routes in slice 5.
- `uploaded` is a state of its own (bundle verified, spec and statement still editable), and a reviewer
  who requests changes moves a version back to it.

## Alternatives considered
Storing the key and encrypting it; a pointer column kept in sync by a trigger; per-role views instead
of policies (more objects to keep in line).
