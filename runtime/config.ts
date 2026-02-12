export interface WranglerConfig {
  name: string;
  main: string;
  kv_namespaces?: { binding: string; id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  durable_objects?: {
    bindings: { name: string; class_name: string }[];
  };
  workflows?: { name: string; binding: string; class_name: string }[];
}

export async function loadConfig(path: string): Promise<WranglerConfig> {
  const raw = await Bun.file(path).text();
  // Strip single-line comments (// ...)
  const stripped = raw.replace(/\/\/.*$/gm, "");
  return JSON.parse(stripped);
}
