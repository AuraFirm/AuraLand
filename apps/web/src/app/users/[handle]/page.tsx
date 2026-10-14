import { ProfileView } from "../../../components/profile-view.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Profile · AuraLand" };

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
    const { handle } = await params;
    return (
        <main className={page}>
            <ProfileView handle={handle} />
            <a className="text-accent underline" href="/arena">
                Arena
            </a>
        </main>
    );
}
