import { ContestsList } from "../../components/contests-list.tsx";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Arena · AuraLand" };

export default function ArenaPage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Arena</h1>
            <ContestsList />
        </main>
    );
}
