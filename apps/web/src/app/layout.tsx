import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { SiteHeader } from "../components/site-header.tsx";
import "./globals.css";

export const metadata: Metadata = {
    title: "AuraLand",
    description: "Verify software capability, for people and for AI.",
};

// Zod normally compiles object schemas with `new Function`, which our content security policy
// forbids (no eval), and it decides that when a schema is first built, which happens as the
// scripts load. This one line runs before them and switches the compiling off, so the browser
// reports no violation. It carries the request's nonce like every other script.
const ZOD_WITHOUT_EVAL = "globalThis.__zod_globalConfig = { jitless: true };";

// Reading request headers makes every page dynamic, which the per-request CSP nonce requires.
export default async function RootLayout({ children }: { children: ReactNode }) {
    const nonce = (await headers()).get("x-nonce") ?? undefined;
    return (
        <html lang="en" data-theme="dark">
            <head>
                <script nonce={nonce}>{ZOD_WITHOUT_EVAL}</script>
            </head>
            <body>
                <SiteHeader />
                {children}
            </body>
        </html>
    );
}
