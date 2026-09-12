import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/element.ts", "src/react.tsx"],
    tsconfig: "./tsconfig.dts.json",
    format: ["esm", "cjs"],
    dts: { tsconfig: "./tsconfig.dts.json" },
    clean: true,
    sourcemap: true,
    target: "es2022",
    external: ["@gagandeep023/support-chat-core", "react", "react/jsx-runtime"],
  },
  {
    // Standalone browser bundle: everything inlined, no import map, no module
    // resolution on the host page. This is the script-tag install path, which is
    // how most sites will actually adopt the widget, and what `support-chat dev`
    // serves.
    entry: { "support-chat": "src/element.ts" },
    outDir: "dist/browser",
    tsconfig: "./tsconfig.dts.json",
    format: ["iife"],
    platform: "browser",
    noExternal: [/.*/],
    dts: false,
    clean: false,
    minify: true,
    sourcemap: false,
    target: "es2020",
  },
]);
