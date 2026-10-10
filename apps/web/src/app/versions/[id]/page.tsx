import { VersionDetail } from "../../../components/version-detail.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Version · AuraLand" };

export default async function VersionPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <VersionDetail versionId={id} />
        </main>
    );
}
