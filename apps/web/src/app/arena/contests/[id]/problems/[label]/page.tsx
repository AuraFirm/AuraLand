import { ProblemWorkspace } from "../../../../../../components/problem-workspace.tsx";
import { page } from "../../../../../../lib/styles.ts";

export const metadata = { title: "Problem · AuraLand" };

export default async function ProblemPage({
    params,
}: {
    params: Promise<{ id: string; label: string }>;
}) {
    const { id, label } = await params;
    return (
        <main className={page}>
            <ProblemWorkspace contestId={id} label={label} />
            <a className="text-accent underline" href={`/arena/contests/${id}`}>
                Back to the contest
            </a>
        </main>
    );
}
