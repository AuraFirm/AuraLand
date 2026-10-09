import { assert } from "@aura/contracts/assert";
import { createWorld, type World } from "./world.ts";

// A scenario is a state machine under test plus the invariants that must hold after every step.
// `start` builds the state inside a world; the returned run keeps that state in a closure, so
// scenarios with different state shapes share one registry type without casts.
// `step` performs one random action; `check` throws if any invariant is broken.

export interface ScenarioRun {
    step(stepIndex: number): void;
    check(): void;
}

export interface Scenario {
    readonly name: string;
    readonly stepsMax: number;
    start(world: World): ScenarioRun;
}

export interface Failure {
    readonly scenario: string;
    readonly seed: number;
    readonly step: number;
    readonly message: string;
}

// Bounds so a typo cannot start an effectively endless run.
export const SIM_STEPS_MAX = 100_000;
export const SIM_SEEDS_MAX = 10_000_000;

export function runScenario(scenario: Scenario, seed: number): Failure | null {
    assert(scenario.stepsMax >= 1 && scenario.stepsMax <= SIM_STEPS_MAX, "steps within bound");
    const world = createWorld(seed);
    let stepIndex = -1;
    try {
        const run = scenario.start(world);
        run.check();
        for (stepIndex = 0; stepIndex < scenario.stepsMax; stepIndex++) {
            run.step(stepIndex);
            run.check();
        }
        return null;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { scenario: scenario.name, seed, step: stepIndex, message };
    }
}

export function runSeeds(scenario: Scenario, firstSeed: number, seedCount: number): Failure[] {
    assert(seedCount >= 1 && seedCount <= SIM_SEEDS_MAX, "seed count within bound");
    const failures: Failure[] = [];
    for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
        const failure = runScenario(scenario, seed);
        if (failure !== null) failures.push(failure);
    }
    return failures;
}

export function formatFailure(failure: Failure): string {
    return `SEED=${failure.seed} SCENARIO=${failure.scenario} STEP=${failure.step} ${failure.message}`;
}
