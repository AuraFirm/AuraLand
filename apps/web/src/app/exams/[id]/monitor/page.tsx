import { ExamMonitor } from "../../../../components/exam-monitor.tsx";
import { page } from "../../../../lib/styles.ts";

export const metadata = { title: "Monitor · AuraLand" };

export default async function MonitorPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={`${page} max-w-5xl`}>
            <ExamMonitor examId={id} />
            <a className="text-accent underline" href={`/exams/${id}`}>
                Back to the exam
            </a>
        </main>
    );
}
