import { defineProject } from "vitest/config";

// Database tests need a real PostgreSQL (docs/kit/03 section 1); they fail loudly without one.
export default defineProject({
    test: { name: "db", include: ["src/**/*.test.ts"], fileParallelism: false, testTimeout: 20000 },
});
