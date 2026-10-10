import { ContinueLink } from "../../../components/continue-link.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Sign-in result · AuraLand" };

const REASONS: Record<string, string> = {
    denied: "You cancelled the sign-in.",
    invalid: "That sign-in could not be completed. Please start again.",
    email_unverified:
        "Your provider has not verified your email address, so we cannot create an account from it.",
    account_exists:
        "An account with this email already exists. Sign in with your passkey or an email link, then connect the provider from your account page.",
    identity_taken: "That provider account is already connected to a different AuraLand account.",
    suspended: "This account is suspended.",
    unavailable: "The provider could not be reached. Try again in a moment.",
};

export default async function DonePage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const query = await searchParams;
    const status = typeof query["status"] === "string" ? query["status"] : "failed";
    const reason = typeof query["reason"] === "string" ? query["reason"] : "";
    const failed = status !== "signed_in" && status !== "linked";
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">
                {status === "signed_in"
                    ? "Signed in"
                    : status === "linked"
                      ? "Account connected"
                      : "Sign-in did not finish"}
            </h1>
            <p role={failed ? "alert" : "status"}>
                {failed ? (REASONS[reason] ?? REASONS["invalid"]) : "All done."}
            </p>
            {failed ? (
                <a className="text-accent underline" href="/sign-in">
                    Back to sign in
                </a>
            ) : (
                <ContinueLink fallback="/account" label="Continue" />
            )}
        </main>
    );
}
