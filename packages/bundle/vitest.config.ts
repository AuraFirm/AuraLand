import { defineProject } from "vitest/config";

// Corpus and fuzz runs decompress and hash real archives; allow more than the default 5 seconds.
export default defineProject({
    test: { name: "bundle", include: ["src/**/*.test.ts"], testTimeout: 60000 },
});
