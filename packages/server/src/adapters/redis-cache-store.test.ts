import { describe, it } from "vitest";
import { describeCacheStore } from "../stores/cache-conformance.js";
import { RedisCacheStore } from "./redis-cache-store.js";

const url = process.env.SUPPORT_CHAT_TEST_REDIS_URL;

if (url) {
  describeCacheStore("redis", () => {
    // A prefix per run, so a previous run's keys cannot make a failure look like
    // an adapter bug.
    const store = new RedisCacheStore({
      url,
      prefix: `sc-test-${Math.random().toString(36).slice(2, 10)}`,
    });
    return { store, dispose: () => store.close() };
  });
} else {
  describe("CacheStore conformance: redis", () => {
    it.skip("needs SUPPORT_CHAT_TEST_REDIS_URL to run", () => undefined);
  });
}
