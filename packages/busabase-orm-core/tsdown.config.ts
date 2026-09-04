import { glob, rm } from "node:fs/promises";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: { generator: "tsgo", tsconfig: "./tsconfig.dts.json" },
  clean: true,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  external: [/^busabase-sdk/],
  // The tsgo declaration generator leaves an intermediate .d.ts beside each
  // source file here. The sibling driver packages happen not to hit it, but
  // nothing about their config guarantees that — so clean up explicitly rather
  // than let build output accumulate in `src/` and show up as untracked files.
  // (`declarationDir` looks like the fix and is not: it makes rolldown fail.)
  async onSuccess() {
    for await (const file of glob("src/*.d.ts")) {
      await rm(file, { force: true });
    }
  },
});
