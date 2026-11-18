import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests import the schema from source, so `pnpm test` works without building first.
    alias: {
      "@ai-observability/schema": fileURLToPath(
        new URL("./packages/schema/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
