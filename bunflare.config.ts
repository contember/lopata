import { defineConfig } from "./runtime/bunflare-config";

export default defineConfig({
  main: "./wrangler.jsonc",
  workers: [
    { name: "echo-worker", config: "./workers/echo/wrangler.jsonc" },
  ],
});
