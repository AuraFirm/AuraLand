import { ScoreboardView } from "../../../../../components/scoreboard-view.tsx";
import { page } from "../../../../../lib/styles.ts";

export const metadata = { title: "Scoreboard · AuraLand" };

export default async function ScoreboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={`${page} max-w-6xl`}>
            <ScoreboardView contestId={id} />
            <a className="text-accent underline" href={`/arena/contests/${id}`}>
                Back to the contest
            </a>
        </main>
    );
}
