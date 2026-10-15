import { EmployerView } from "../../components/employer-view.tsx";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Employer · AuraLand" };

export default function EmployerPage() {
    return (
        <main className={page}>
            <EmployerView />
        </main>
    );
}
