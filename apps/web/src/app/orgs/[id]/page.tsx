import { OrgDetail } from "../../../components/org-detail.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Organization · AuraLand" };

export default async function OrgPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <OrgDetail orgId={id} />
        </main>
    );
}
