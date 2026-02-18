import { bunflare } from "bunflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    bunflare({
      viteEnvironment: { name: "ssr" },
      configPath: "./wrangler.jsonc",
    }),
    reactRouter(),
  ],
});
