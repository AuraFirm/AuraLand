import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security-headers.ts";

// Hardening rules are in docs/kit/03 section 3 and ADR 0005. In short: this app only renders UI.
// No Server Actions, no image optimizer, no ISR, no auth in the proxy.
const config: NextConfig = {
    output: "standalone",
    // The monorepo root, so the standalone build traces files from workspace packages too.
    outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
    poweredByHeader: false,
    reactStrictMode: true,
    // The image optimizer has had critical advisories and we do not use it.
    images: { unoptimized: true },
    transpilePackages: ["@aura/contracts"],
    // TypeScript 7 no longer exposes the compiler API that `next build` loads for its own type
    // check, so type checking runs separately as `pnpm check:types` (tsc), which CI requires.
    typescript: { ignoreBuildErrors: true },
    async headers() {
        return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS.map((h) => ({ ...h })) }];
    },
};

export default config;
