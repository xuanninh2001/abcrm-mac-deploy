import { defineConfig } from "vitest/config";
// DB tests share one database: run files sequentially.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 } });
