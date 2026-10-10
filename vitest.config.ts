import { defineConfig } from "vitest/config";

// One root config with an explicit project per workspace keeps `pnpm test` a single entry point.
export default defineConfig({
    test: {
        projects: [
            "tools",
            "apps/api",
            "apps/web",
            "packages/contracts",
            "packages/bundle",
            "packages/db",
        ],
    },
});
