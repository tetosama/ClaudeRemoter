import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    coverage: { reporter: ["text", "html"] },
  },
});
