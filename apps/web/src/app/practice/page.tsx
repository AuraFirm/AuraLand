import { PracticeList } from "../../components/practice-list.tsx";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Practice · AuraLand" };

export default function PracticePage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Practice</h1>
            <PracticeList />
        </main>
    );
}
