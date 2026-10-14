import { ExamOral } from "../../../../components/exam-oral.tsx";
import { page } from "../../../../lib/styles.ts";

export const metadata = { title: "Oral defence · AuraLand" };

export default async function OralPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={`${page} max-w-5xl`}>
            <ExamOral examId={id} />
            <a className="text-accent underline" href={`/exams/${id}`}>
                Back to the exam
            </a>
        </main>
    );
}
