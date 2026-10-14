import { ExamDetail } from "../../../components/exam-detail.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Exam · AuraLand" };

export default async function ExamPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <ExamDetail examId={id} />
        </main>
    );
}
