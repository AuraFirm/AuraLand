import { page } from "../../lib/styles.ts";

export const metadata = { title: "Methodology · AuraLand" };

// What we claim about a task pack and what we do not. The page is plain text kept in the code, so a
// change to a claim is a reviewed change with a history. It describes the process as it is today;
// when validation exists (Stage 4B) this page changes in the same pull request that adds it.
export default function MethodologyPage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Methodology</h1>
            <HowATaskIsMade />
            <HowATaskIsValidated />
            <WhatYouReceive />
        </main>
    );
}

function HowATaskIsMade() {
    return (
        <section aria-labelledby="made" className="flex flex-col gap-2">
            <h2 id="made" className="text-lg font-semibold">
                How a task is made
            </h2>
            <p>
                A setter writes the statement, the specification and a bundle of tests and reference
                files. The bundle is checked on upload for size and hash, and unpacked only by a
                validator that refuses anything outside a strict format. A different person, a
                reviewer, then reads it and decides. Nobody releases their own work. Every step is
                recorded with who did it and when.
            </p>
        </section>
    );
}

function HowATaskIsValidated() {
    return (
        <section aria-labelledby="validated" className="flex flex-col gap-2">
            <h2 id="validated" className="text-lg font-semibold">
                How a task is validated, and what that does not prove
            </h2>
            <p>
                A reviewer can ask for validation. A judge node then runs the task's own solutions
                in a sandbox: the reference must pass every test, twice with the same verdicts, and
                every wrong solution must fail at least one. The node also changes the reference in
                up to forty small ways (a swapped operator, a number off by one) and sees whether
                the tests notice, and runs ten deliberately lazy programs (look the samples up, echo
                the input, print a constant) to see whether the tests accept any of them. The node
                only reports what it saw; our servers draw the conclusions and store an unchangeable
                report.
            </p>
            <p>
                The <strong>ungameability score</strong> (formula version 1) is 40 points for the
                share of changed references the tests caught, 30 for the share of lazy programs they
                rejected, 20 for the share of consistency checks that passed and 10 for the share of
                test groups holding at least two tests. A task needs at least 70, and every
                consistency check, to count as validated. A task that a program ignorant of its
                statement can solve completely does not pass, even if it is a perfectly good
                exercise.
            </p>
            <p>
                <strong>What it does not prove.</strong> It does not show that the statement is
                clear, that the difficulty is right, that no clever solution exists, or that the
                tests are free of mistakes beyond those the wrong solutions expose. We have not yet
                measured difficulty with models or attacked tasks with agents and people.
            </p>
            <p>
                <strong>Which sandbox.</strong> Every report records the kind of machine that
                produced it. Until a production judge node has been independently reviewed, a pack
                can be at most <strong>validated on a development sandbox only</strong>, and its
                delivery says exactly that. We will use the plain word “validated” only for a report
                from a reviewed production node. A pack with no report still says
                <strong> validation: not performed</strong>.
            </p>
        </section>
    );
}

function WhatYouReceive() {
    return (
        <section aria-labelledby="delivery" className="flex flex-col gap-2">
            <h2 id="delivery" className="text-lg font-semibold">
                What you receive
            </h2>
            <p>
                A delivery is the original bundles plus a manifest that lists each file with its
                SHA-256 and size, the licence terms and the provenance each author declared. The
                manifest has its own hash, shown in the portal, so you can check that what you hold
                is what we sent. Each statement carries a short reference that identifies your
                delivery. Where a task's files allow it without any risk to the results, your copy
                of the bundle also carries a small mark that is different for every delivery (extra
                spaces at the ends of answer lines for checkers that ignore spacing, and a comment
                line in each reference solution), so that a leaked copy can be traced to the
                delivery it came from. Test inputs are never touched. A node re-runs the task's own
                solutions on your copy and ours, and a copy ships only if every verdict is the same;
                the manifest lists which marks your copy carries. A leaker who removes the marks can
                defeat this, and we do not claim otherwise. Downloads are logged, links last five
                minutes and a delivery expires on the date shown.
            </p>
        </section>
    );
}
