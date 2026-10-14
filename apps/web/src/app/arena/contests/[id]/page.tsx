import { ContestDetail } from "../../../../components/contest-detail.tsx";
import { page } from "../../../../lib/styles.ts";

export const metadata = { title: "Contest · AuraLand" };

export default async function ContestPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <ContestDetail contestId={id} />
            <a className="text-accent underline" href="/arena">
                All contests
            </a>
        </main>
    );
}
