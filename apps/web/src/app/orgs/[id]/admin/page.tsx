import { OrgAdminConsole } from "../../../../components/org-admin-console.tsx";
import { page } from "../../../../lib/styles.ts";

export const metadata = { title: "Admin console · AuraLand" };

export default async function OrgAdminPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <OrgAdminConsole orgId={id} />
        </main>
    );
}
