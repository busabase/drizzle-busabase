import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    alias: {
      "busabase-orm-core": path.resolve(__dirname, "../busabase-orm-core/src/index.ts"),
    },
  },
});
