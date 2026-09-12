import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  tsconfig: "./tsconfig.dts.json",
  format: ["esm"],
  dts: { tsconfig: "./tsconfig.dts.json" },
  clean: true,
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@gagandeep023/support-chat-core",
    "@gagandeep023/support-chat-server",
    "@gagandeep023/support-chat-widget",
  ],
});
