import { ExamReplay } from "../../../../../../components/exam-replay.tsx";
import { page } from "../../../../../../lib/styles.ts";

export const metadata = { title: "Replay · AuraLand" };

export default async function ReplayPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string; session: string; label: string }>;
    searchParams: Promise<{ from_seq?: string }>;
}) {
    const { id, session, label } = await params;
    const { from_seq: fromSeqText } = await searchParams;
    const fromSeq = Math.max(1, Number.parseInt(fromSeqText ?? "1", 10) || 1);
    return (
        <main className={`${page} max-w-5xl`}>
            <ExamReplay examId={id} sessionId={session} label={label} fromSeq={fromSeq} />
            <a className="text-accent underline" href={`/exams/${id}/monitor`}>
                Back to the monitor
            </a>
        </main>
    );
}
