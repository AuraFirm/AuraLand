import { CredentialVerify } from "../../../components/credential-verify.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Verify a credential · AuraLand" };

export default async function VerifyPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <CredentialVerify id={id} />
        </main>
    );
}
