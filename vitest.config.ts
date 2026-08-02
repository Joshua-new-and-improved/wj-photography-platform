import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Image derivation does real work: a 24 MP source through an AVIF encoder
    // is seconds, not milliseconds. The default 5s timeout fails these on a
    // cold CI runner even when the code is correct.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
