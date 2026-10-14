import { ExamSimilarity } from "../../../../components/exam-similarity.tsx";
import { page } from "../../../../lib/styles.ts";

export const metadata = { title: "Similarity · AuraLand" };

export default async function SimilarityPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={`${page} max-w-5xl`}>
            <ExamSimilarity examId={id} />
            <a className="text-accent underline" href={`/exams/${id}`}>
                Back to the exam
            </a>
        </main>
    );
}
