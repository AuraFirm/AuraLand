import { AccountData } from "../../components/account-data.tsx";
import { AccountIdentities } from "../../components/account-identities.tsx";
import { AccountPasskeys } from "../../components/account-passkeys.tsx";
import { AccountProfile } from "../../components/account-profile.tsx";
import { AccountSessions } from "../../components/account-sessions.tsx";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Account · AuraLand" };

export default function AccountPage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Account</h1>
            <AccountProfile />
            <AccountPasskeys />
            <AccountIdentities />
            <AccountSessions />
            <AccountData />
        </main>
    );
}
