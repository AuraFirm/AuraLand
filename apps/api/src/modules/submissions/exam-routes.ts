import { examProblemViewSchema } from "@aura/contracts/api/exams";
import { decodeId, idSchema } from "@aura/contracts/ids";
import { judgeLanguageSchema } from "@aura/contracts/judging";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { renderMarkdownSafe } from "../../platform/markdown.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { examProblemView } from "./queries.ts";

// The statement and limits of one exam problem, for the person sitting it (Stage 6, slice 3). The version row
// is visible only once their own sitting has started (row-level security, migration 0044), so anyone else
// gets the same 404. An allowlist: never the tests, the checker or the bundle.
export function examProblemRoutes(): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/exams/:id/problems/:label", handleProblem);
    return routes;
}

async function handleProblem(c: Context<AppEnv>) {
    if (c.get("actor").kind !== "user") {
        return problemResponse(c, "unauthenticated", "Authentication required");
    }
    const id = idSchema("exm").safeParse(c.req.param("id"));
    const label = c.req.param("label") ?? "";
    if (!id.success || !/^[A-Z][A-Z0-9]{0,2}$/.test(label)) {
        return problemResponse(c, "invalid_request", "Invalid request");
    }
    const problem = await examProblemView(c.get("tx"), {
        examId: decodeId("exm", id.data),
        label,
    });
    if (problem === null || problem.spec === null || problem.statement === null) {
        return problemResponse(c, "not_found", "Not found");
    }
    return c.json(
        examProblemViewSchema.parse({
            label: problem.label,
            points: problem.points,
            title: problem.spec.title,
            time_limit_ms: problem.spec.time_limit_ms,
            memory_limit_kib: problem.spec.memory_limit_kib,
            languages: problem.spec.languages.filter(
                (l) => judgeLanguageSchema.safeParse(l).success,
            ),
            statement_html: renderMarkdownSafe(problem.statement).html,
        }),
    );
}
