import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
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
    // The first NestJS app in a file takes a few seconds to boot on slower machines.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
