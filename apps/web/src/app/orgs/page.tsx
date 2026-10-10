import { OrgsList } from "../../components/orgs-list.tsx";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Organizations · AuraLand" };

export default function OrgsPage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Organizations</h1>
            <OrgsList />
        </main>
    );
}
