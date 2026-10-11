import type { SubmissionItem } from "@aura/contracts/api/submissions";
import type { Verdict } from "@aura/contracts/judging";

const VERDICT_TEXT: Record<Verdict, string> = {
    AC: "Accepted",
    WA: "Wrong answer",
    TLE: "Time limit exceeded",
    MLE: "Memory limit exceeded",
    OLE: "Output limit exceeded",
    RTE: "Runtime error",
    CE: "Compilation error",
    PARTIAL: "Partially correct",
    SE: "System error",
};

// The verdict panel. A system error is never described as the person's fault.
export function SubmissionResult({ item }: { item: SubmissionItem }) {
    if (item.state === "queued") return <p role="status">Waiting for a judge…</p>;
    if (item.state === "judging") return <p role="status">Being judged…</p>;
    if (item.state === "failed_system") {
        return (
            <p role="alert">
                The judge could not finish this submission. That is our problem, not yours. Please
                submit again.
            </p>
        );
    }
    if (item.state === "cancelled") return <p role="status">This submission was cancelled.</p>;
    const text = item.verdict === null ? "Judged" : VERDICT_TEXT[item.verdict];
    return (
        <div className="mt-3" aria-live="polite">
            <p className="text-lg font-semibold">
                {text}
                {item.score !== null ? ` · ${item.score} points` : ""}
            </p>
            {item.tests !== null && item.tests.length > 0 && (
                <table className="mt-2 text-sm">
                    <caption className="sr-only">Results by test</caption>
                    <thead>
                        <tr>
                            <th scope="col" className="pr-4 text-left">
                                Test
                            </th>
                            <th scope="col" className="pr-4 text-left">
                                Result
                            </th>
                            <th scope="col" className="pr-4 text-left">
                                Time
                            </th>
                            <th scope="col" className="text-left">
                                Memory
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {item.tests.map((test) => (
                            <tr key={test.test_id}>
                                <td className="pr-4">{test.test_id}</td>
                                <td className="pr-4">{test.verdict}</td>
                                <td className="pr-4">{test.cpu_ms} ms</td>
                                <td>{Math.round(test.memory_kib / 1024)} MiB</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
