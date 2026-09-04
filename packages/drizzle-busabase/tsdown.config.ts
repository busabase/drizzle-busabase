import { glob, rm } from "node:fs/promises";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: { generator: "tsgo", tsconfig: "../tsconfig.drizzle-busabase-dts.json" },
  clean: true,
  // `exports` points at ./dist/*.js and ./dist/*.d.ts; tsdown's default would
  // emit .mjs/.d.mts instead.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  // drizzle-orm is a peer dependency and busabase-sdk a real one — neither is bundled.
  external: [/^drizzle-orm/, /^busabase-sdk/],
  // busabase-orm-core is a workspace package that is NOT published to npm on its
  // own: it is the shared half of the driver, and shipping it as a separate
  // dependency would make installing this package a two-step affair for no gain
  // (nobody consumes the core directly). Bundling it in is what busabase-sdk does
  // with its own workspace deps, for the same reason — the published package then
  // has zero workspace dependencies and installs standalone.
  noExternal: [/^busabase-orm-core/],
  // The tsgo declaration generator leaves an intermediate .d.ts beside every
  // source file it compiles — and because busabase-orm-core is bundled (see
  // noExternal above), that now includes ITS sources, not just this package's.
  // Clean both up rather than leave build output as untracked files in a
  // sibling package. (`declarationDir` looks like the fix and is not: it makes
  // rolldown fail outright.)
  async onSuccess() {
    for (const pattern of ["src/*.d.ts", "../busabase-orm-core/src/*.d.ts"]) {
      for await (const file of glob(pattern)) {
        await rm(file, { force: true });
      }
    }
  },
});
