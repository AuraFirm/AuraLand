import { TaskDetail } from "../../../components/task-detail.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Task · AuraLand" };

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <TaskDetail taskId={id} />
        </main>
    );
}
