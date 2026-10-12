import { page } from "../../lib/styles.ts";

export const metadata = { title: "Methodology · AuraLand" };

// What we claim about a task pack and what we do not. The page is plain text kept in the code, so a
// change to a claim is a reviewed change with a history. It describes the process as it is today;
// when validation exists (Stage 4B) this page changes in the same pull request that adds it.
export default function MethodologyPage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Methodology</h1>
            <section aria-labelledby="made" className="flex flex-col gap-2">
                <h2 id="made" className="text-lg font-semibold">
                    How a task is made
                </h2>
                <p>
                    A setter writes the statement, the specification and a bundle of tests and
                    reference files. The bundle is checked on upload for size and hash, and unpacked
                    only by a validator that refuses anything outside a strict format. A different
                    person, a reviewer, then reads it and decides. Nobody releases their own work.
                    Every step is recorded with who did it and when.
                </p>
            </section>
            <section aria-labelledby="validated" className="flex flex-col gap-2">
                <h2 id="validated" className="text-lg font-semibold">
                    What has not been done yet
                </h2>
                <p>
                    We do not yet run a task's reference solution and wrong solutions in a sandbox,
                    mutate its tests, measure its difficulty with models or attack it with agents
                    and people. Every delivery says <strong>validation: not performed</strong>
                    for that reason. We will not call a pack validated, and we will not publish an
                    ungameability score, until those steps run and their results are stored with the
                    pack.
                </p>
            </section>
            <section aria-labelledby="delivery" className="flex flex-col gap-2">
                <h2 id="delivery" className="text-lg font-semibold">
                    What you receive
                </h2>
                <p>
                    A delivery is the original bundles plus a manifest that lists each file with its
                    SHA-256 and size, the licence terms and the provenance each author declared. The
                    manifest has its own hash, shown in the portal, so you can check that what you
                    hold is what we sent. Each statement carries a short reference that identifies
                    your delivery. Downloads are logged, links last five minutes and a delivery
                    expires on the date shown.
                </p>
            </section>
        </main>
    );
}
