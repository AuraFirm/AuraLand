import { ENV_FLAG_KINDS } from "@aura/contracts/judge-protocol";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for environments and runs. Users act as `aura_app`; the node's report goes through `aura_worker`.

const environmentRow = z.object({
    id: z.string(),
    org_id: z.string(),
    slug: z.string(),
    title: z.string(),
    spec: z.object({
        image: z.object({ digest: z.string() }),
        network: z.object({ mode: z.enum(["none", "allowlist"]) }),
    }),
    created_at: z.date(),
});
export type EnvironmentRow = z.infer<typeof environmentRow>;

export async function createEnvironment(
    tx: Transaction,
    input: {
        org: string;
        slug: string;
        title: string;
        spec: object;
        imageKey: string;
        hiddenKey: string;
        hiddenSha256: string;
        nowMs: number;
    },
): Promise<string> {
    const [row] =
        await tx`select create_environment(${input.org}, ${input.slug}, ${input.title}, ${tx.json(JSON.parse(JSON.stringify(input.spec)))},
        ${input.imageKey}, ${input.hiddenKey}, ${Buffer.from(input.hiddenSha256, "hex")}, ${new Date(input.nowMs)}) as id`;
    return z.object({ id: z.string() }).parse(row).id;
}

export async function listEnvironments(tx: Transaction, org: string): Promise<EnvironmentRow[]> {
    const rows = await tx`select id, org_id, slug, title, spec, created_at from environments
        where org_id = ${org} and retired_at is null order by id desc limit 100`;
    return rows.map((row) => environmentRow.parse(row));
}

// The organization an environment belongs to; null when it does not exist or the caller cannot see it.
export async function environmentOrg(tx: Transaction, env: string): Promise<string | null> {
    const [row] = await tx`select org_id from environments where id = ${env}`;
    return row === undefined ? null : z.object({ org_id: z.string() }).parse(row).org_id;
}

// Runs asked for since `sinceMs` that have not finished: they will be billed when they do, so they count against the limit now.
export async function queuedRunsSince(
    tx: Transaction,
    org: string,
    sinceMs: number,
): Promise<number> {
    const [row] = await tx`select count(*)::int as n from env_runs
        where org_id = ${org} and state = 'queued' and created_at >= ${new Date(sinceMs)}`;
    return z.object({ n: z.number() }).parse(row).n;
}

export async function requestRun(
    tx: Transaction,
    input: {
        env: string;
        label: string;
        delivery: boolean;
        optedIn: boolean;
        level: number;
        nowMs: number;
    },
): Promise<string> {
    const [row] =
        await tx`select request_env_run(${input.env}, ${input.label}, ${input.delivery}, ${input.optedIn},
        ${input.level}, ${new Date(input.nowMs)}) as id`;
    return z.object({ id: z.string() }).parse(row).id;
}

const runRow = z.object({
    id: z.string(),
    environment_id: z.string(),
    agent_label: z.string(),
    state: z.enum(["queued", "done", "failed"]),
    isolation: z.enum(["gvisor", "firecracker"]).nullable(),
    outcome: z.enum(["completed", "setup_failed", "sandbox_error"]).nullable(),
    score: z.coerce.number().nullable(),
    eligible: z.boolean(),
    flags: z.array(
        z.object({ kind: z.enum(ENV_FLAG_KINDS), subject: z.string(), explanation: z.string() }),
    ),
    created_at: z.date(),
    finished_at: z.date().nullable(),
});
export type RunRow = z.infer<typeof runRow>;

export async function listRuns(tx: Transaction, env: string): Promise<RunRow[]> {
    const rows =
        await tx`select id, environment_id, agent_label, state, isolation, outcome, score, eligible,
        coalesce(trace -> 'flags', '[]'::jsonb) as flags, created_at, finished_at
        from env_runs where environment_id = ${env} order by id desc limit 100`;
    return rows.map((row) => runRow.parse(row));
}

export async function getRun(tx: Transaction, run: string): Promise<RunRow | null> {
    const rows =
        await tx`select id, environment_id, agent_label, state, isolation, outcome, score, eligible,
        coalesce(trace -> 'flags', '[]'::jsonb) as flags, created_at, finished_at from env_runs where id = ${run}`;
    return rows[0] === undefined ? null : runRow.parse(rows[0]);
}

const workRow = z.object({
    run_state: z.string(),
    env_id: z.string(),
    spec: z.record(z.string(), z.unknown()),
    image_key: z.string(),
    hidden_key: z.string(),
    hidden_sha256: z.instanceof(Uint8Array),
});
export type EnvRunWork = z.infer<typeof workRow>;

// What a node needs to run one environment. Read as the worker; a run that is not waiting has no work.
export async function readWork(tx: Transaction, run: string): Promise<EnvRunWork | null> {
    const rows =
        await tx`select r.state as run_state, e.id as env_id, e.spec, e.image_key, e.hidden_key, e.hidden_sha256
        from env_runs r join environments e on e.id = r.environment_id where r.id = ${run}`;
    return rows[0] === undefined ? null : workRow.parse(rows[0]);
}

export const finishRun = (
    tx: Transaction,
    input: {
        run: string;
        node: string;
        isolation: string;
        outcome: string;
        score: number | null;
        trace: unknown;
        signature: string;
        nowMs: number;
    },
) =>
    tx`select finish_env_run(${input.run}, ${input.node}, ${input.isolation}, ${input.outcome}, ${input.score},
        ${tx.json(JSON.parse(JSON.stringify(input.trace)))}, ${input.signature}, ${new Date(input.nowMs)})`;

const leaderboardRow = z.object({
    agent_label: z.string(),
    best_score: z.coerce.number(),
    runs: z.coerce.number(),
    flagged_runs: z.coerce.number(),
    isolation: z.enum(["gvisor", "firecracker"]),
    achieved_at: z.date(),
});
export type LeaderboardRow = z.infer<typeof leaderboardRow>;

// Each agent's best eligible result; ties go to whoever reached it first, then to the label so the order is total.
// `runs` counts every finished run of the agent (including ineligible ones) so the board does not hide how often they tried.
export async function leaderboard(tx: Transaction, env: string): Promise<LeaderboardRow[]> {
    const rows = await tx`
        with best as (
            select distinct on (agent_label) agent_label, score, isolation, finished_at
              from env_runs where environment_id = ${env} and eligible and score is not null
             order by agent_label, score desc, finished_at, id
        ), counts as (
            select agent_label, count(*) as runs,
                   count(*) filter (where jsonb_array_length(coalesce(trace -> 'flags', '[]'::jsonb)) > 0) as flagged_runs
              from env_runs where environment_id = ${env} and state = 'done' group by agent_label
        )
        select b.agent_label, b.score as best_score, c.runs, c.flagged_runs, b.isolation, b.finished_at as achieved_at
          from best b join counts c using (agent_label)
         order by b.score desc, b.finished_at, b.agent_label limit 100`;
    return rows.map((row) => leaderboardRow.parse(row));
}
