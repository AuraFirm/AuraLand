import { PracticeProblem } from "../../../components/practice-problem.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Practice problem · AuraLand" };

export default async function PracticeProblemPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <PracticeProblem id={id} />
            <a className="text-accent underline" href="/practice">
                All practice problems
            </a>
        </main>
    );
}
