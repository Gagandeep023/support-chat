import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/index.ts",
    "src/adapters/sqlite.ts",
    "src/adapters/postgres.ts",
    "src/adapters/redis.ts",
    "src/adapters/pgvector.ts",
    "src/embeddings/index.ts",
    "src/testing.ts",
  ],
  tsconfig: "./tsconfig.dts.json",
  format: ["esm", "cjs"],
  dts: { tsconfig: "./tsconfig.dts.json" },
  clean: true,
  sourcemap: true,
  target: "es2022",
  // `pg` is an optional peer: never bundled, so installing this package does
  // not pull a Postgres driver for someone running SQLite.
  external: ["@gagandeep023/support-chat-core", "pg", "ioredis", "@socket.io/redis-adapter", "@huggingface/transformers", "node:sqlite", "vitest"],
});
