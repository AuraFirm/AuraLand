import { ExamGrading } from "../../../../components/exam-grading.tsx";
import { page } from "../../../../lib/styles.ts";

export const metadata = { title: "Grading · AuraLand" };

export default async function GradingPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={`${page} max-w-5xl`}>
            <ExamGrading examId={id} />
            <a className="text-accent underline" href={`/exams/${id}`}>
                Back to the exam
            </a>
        </main>
    );
}
