export default function HomePage() {
    return (
        <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4">
            <h1 className="text-3xl font-semibold">
                Aura<span className="text-accent">Land</span>
            </h1>
            <p className="text-muted">
                Proof you can trust. We verify software capability, for people and for AI.
            </p>
            <nav aria-label="Main" className="flex gap-4">
                <a className="text-accent underline" href="/sign-in">
                    Sign in
                </a>
                <a className="text-accent underline" href="/account">
                    Account
                </a>
                <a className="text-accent underline" href="/orgs">
                    Organizations
                </a>
            </nav>
        </main>
    );
}
