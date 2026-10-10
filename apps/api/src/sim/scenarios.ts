import { loginScenario } from "./login.sim.ts";
import type { Scenario } from "./runner.ts";
import { boundedQueueScenario } from "./selftest.sim.ts";
import { sessionScenario } from "./sessions.sim.ts";
import { taskVersionScenario } from "./task-versions.sim.ts";

// Registry of scenarios run by `pnpm test:sim`. Later stages add the lease/fencing, scoreboard,
// exam autosave and credential scenarios here. The buggy variant is deliberately not registered.
export const SCENARIOS: readonly Scenario[] = [
    boundedQueueScenario(false),
    sessionScenario("none"),
    loginScenario(),
    taskVersionScenario(),
];
