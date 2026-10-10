import { FragmentToken } from "../../../components/fragment-token.tsx";

export const metadata = { title: "Signing in · AuraLand" };

export default function VerifyPage() {
    return (
        <FragmentToken
            path="/auth/email/verify"
            next="/account"
            title="Signing you in"
            working="Checking your link…"
        />
    );
}
