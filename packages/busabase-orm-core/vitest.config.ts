import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    alias: {
      "busabase-sdk": path.resolve(__dirname, "../../apps/busabase-sdk/src/index.ts"),
    },
  },
});
