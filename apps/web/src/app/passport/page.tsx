import { PassportView } from "../../components/passport-view.tsx";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Passport · AuraLand" };

export default function PassportPage() {
    return (
        <main className={page}>
            <PassportView />
        </main>
    );
}
