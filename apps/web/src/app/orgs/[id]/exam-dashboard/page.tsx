import { ExamDashboard } from "../../../../components/exam-dashboard.tsx";
import { page } from "../../../../lib/styles.ts";

export const metadata = { title: "Exam dashboard · AuraLand" };

export default async function ExamDashboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={`${page} max-w-5xl`}>
            <ExamDashboard orgId={id} />
            <a className="text-accent underline" href={`/orgs/${id}`}>
                Back to the organization
            </a>
        </main>
    );
}
