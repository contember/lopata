export interface WranglerConfig {
  name: string;
  main: string;
  kv_namespaces?: { binding: string; id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  durable_objects?: {
    bindings: { name: string; class_name: string }[];
  };
  workflows?: { name: string; binding: string; class_name: string }[];
  d1_databases?: { binding: string; database_name: string; database_id: string }[];
  queues?: {
    producers?: { binding: string; queue: string; delivery_delay?: number }[];
    consumers?: { queue: string; max_batch_size?: number; max_batch_timeout?: number; max_retries?: number; dead_letter_queue?: string }[];
  };
  services?: { binding: string; service: string; entrypoint?: string }[];
  triggers?: { crons?: string[] };
  vars?: Record<string, string>;
  assets?: {
    directory: string;
    binding?: string;
    html_handling?: "none" | "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash";
    not_found_handling?: "none" | "404-page" | "single-page-application";
  };
}

export async function loadConfig(path: string): Promise<WranglerConfig> {
  const raw = await Bun.file(path).text();
  // Strip single-line comments (// ...)
  const stripped = raw.replace(/\/\/.*$/gm, "");
  return JSON.parse(stripped);
}
