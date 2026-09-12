import { defineConfig } from "tsup";

// With "type": "module", tsup emits .js (ESM) and .cjs (CJS).
export default defineConfig({
  entry: ["src/index.ts", "src/protocol/index.ts"],
  tsconfig: "./tsconfig.dts.json",
  format: ["esm", "cjs"],
  dts: { tsconfig: "./tsconfig.dts.json" },
  clean: true,
  sourcemap: true,
  target: "es2022",
});
