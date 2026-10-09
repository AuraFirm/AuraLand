import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
    title: "AuraLand",
    description: "Verify software capability, for people and for AI.",
};

// Reading request headers makes every page dynamic, which the per-request CSP nonce requires.
export default async function RootLayout({ children }: { children: ReactNode }) {
    await headers();
    return (
        <html lang="en" data-theme="dark">
            <body>{children}</body>
        </html>
    );
}
