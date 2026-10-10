import { SignInForm } from "../../components/sign-in-form.tsx";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Sign in · AuraLand" };

export default function SignInPage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Sign in</h1>
            <p className="text-muted">New here? Signing in creates your account.</p>
            <SignInForm />
        </main>
    );
}
