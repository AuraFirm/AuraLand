# Contests runbook (pilot)

For the person running a contest. Everything here was exercised on a development machine, not on a deployment (F1), and
**no real judge fleet exists yet (F32)**: do not run a real contest on this until those are done. A pilot of 200+
people needs an edge/CDN, several API instances and a reviewed production judge fleet; this file is what to do once they
exist. API calls below need a signed-in session (`-b` cookie), the header `x-aura-request: 1`, and an `Origin` equal to
the site; "step-up" means a passkey check in the last 15 minutes.

## 1. Before the contest
1. Problems come from **released** versions of the host organization's tasks, or public tasks of the platform bank.
   List `java` in a task's spec languages if Java should be accepted; a contest offers only languages its rules list.
2. Create the contest on the organization page (UI): title, address, times (UTC shown beside local), rules (ICPC
   penalty, minimum seconds between two submissions to one problem, languages), freeze time, rated or not. **A rated
   contest must be public.** Add problems with labels A, B, ... then **Publish**. After publishing nothing about the
   contest or its problems changes (there is no extend or cancel; pick the times with care).
3. Check as a stranger (signed out): the contest page shows the countdown by the server's clock and **no** problems'
   statements. Register a test account and confirm the statements appear only once it runs.
4. Run the escape suite and `TestLanguages` on every judge node for every language the contest offers (judge runbook
   section 6). A node that fails must not take contest work.
5. Tell people that a Java class must be `public class Main`, and that per-test results appear only after the end.

## 2. During the contest
Watch, every few minutes (replace `<c>` with the contest uuid):
```sql
select state, count(*) from submissions where context_id = '<c>' group by 1;            -- queued should not pile up
select count(*) from jobs where queue = 'judge' and state = 'ready';                      -- queue depth (contest cap 10,000)
select version, updated_at from contest_scoreboards where contest_id = '<c>' and view = 'public';  -- moves about once a second under activity
select count(*) from jobs where state = 'dead' and queue = 'judge';                       -- should be 0
```
- **Judging is slow or down:** set the banner (administrator, step-up):
  `curl -b cookie -H 'x-aura-request: 1' -H 'content-type: application/json' -X PUT $SITE/api/v1/admin/status -d '{"level":"degraded","message":"Judging is slow; your submissions are safe and will be judged."}'`.
  Clear it with `{"level":"ok","message":""}`. Submissions queue; nothing is lost.
- **Questions:** list `GET /contests/<id>/clarifications` as an organizer; answer with
  `POST /contests/<id>/clarifications/<clr>/answer {"answer":"...","public":true}` (once; public shows to everyone).
  There is no screen for answering yet (F47): use the API.
- **A wrong verdict (a bad test, a node fault):** fix it by **rejudge**:
  `POST /contests/<id>/submissions/<sub>/rejudge` (owner or admin). The old verdict keeps counting until the new one
  arrives; it cannot be done after finalizing. A failed-by-system submission can be rejudged the same way.
- **The scoreboard looks stale:** the snapshot is cached for one second at the edge; the stream only announces a new
  version. Check the worker is running (the version above stops moving if not) and restart it; boards rebuild from the
  log.
- **API unresponsive under load:** requests beyond the line get 503 with `Retry-After`. Add instances; do not raise the
  pool (the gate is half the pool by design).

## 3. After the contest
1. At the end the clock moves the contest to `ended`. Frozen boards stay frozen for the public. **Unfreeze**
   (`POST /contests/<id>/unfreeze`, owner or admin, once) or **Finalize** on the contest page (finalizing also unfreezes).
2. Per-test results of every submission open to their owners at the end.
3. After finalizing, a **rated** contest is rated by the worker within seconds (oldest finalized first, one per 5 s);
   check `select status, participants from contest_ratings where contest_id = '<c>'`. `skipped` means fewer than 20
   people submitted. A contest is rated once; ratings are never edited.
4. ICPC tools: `GET /contests/<id>/standings.icpc.json` (add `?view=final` as staff). IOI contests have no such export.

## 4. Problems you may meet
| Symptom | Likely cause | What to do |
|---|---|---|
| Nobody can submit | contest not `running` (worker stopped, so the clock did not move) | start the worker; the state catches up through every missed state |
| `409` on submit | window closed, or the problem is in the contest and the person used the practice route | expected |
| `429` with `Retry-After` | the minimum interval between submissions to one problem, or 30 a minute | expected; the header says how long |
| Rating did not appear | contest not rated, not public, not finalized, or an older contest is unrated | `select * from contest_ratings`; the worker log says `rating error` if a run fails (it retries) |
| A deleted-by-mistake bank entry | `DELETE /admin/practice/<tsv>` | list it again with `POST /admin/practice` |

## 5. Rolling back
There is no feature flag for contests as a whole. To stop new activity: set the banner; to stop a node: revoke it
(see the judge runbook). Migrations 0033 to 0043 are additive; do not drop their tables with data in them.
