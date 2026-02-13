import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

export interface BunflareConfig {
  /** Path to the main worker's wrangler config (HTTP entrypoint) */
  main: string;
  /** Auxiliary workers, each with a service name and wrangler config path */
  workers?: Array<{
    name: string;
    config: string;
  }>;
}

export function defineConfig(config: BunflareConfig): BunflareConfig {
  return config;
}

/**
 * Try to load `bunflare.config.ts` from the given directory.
 * Returns null if the file doesn't exist.
 * All paths in the returned config are resolved relative to baseDir.
 */
export async function loadBunflareConfig(baseDir: string): Promise<BunflareConfig | null> {
  const configPath = join(baseDir, "bunflare.config.ts");
  if (!existsSync(configPath)) return null;

  const mod = await import(configPath);
  const config: BunflareConfig = mod.default ?? mod;

  // Resolve all paths relative to baseDir
  config.main = resolve(baseDir, config.main);
  if (config.workers) {
    for (const worker of config.workers) {
      worker.config = resolve(baseDir, worker.config);
    }
  }

  return config;
}
