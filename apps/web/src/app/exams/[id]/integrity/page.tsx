import { ExamIntegrity } from "../../../../components/exam-integrity.tsx";
import { page } from "../../../../lib/styles.ts";

export const metadata = { title: "Integrity review · AuraLand" };

export default async function IntegrityPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={`${page} max-w-5xl`}>
            <ExamIntegrity examId={id} />
            <a className="text-accent underline" href={`/exams/${id}`}>
                Back to the exam
            </a>
        </main>
    );
}
