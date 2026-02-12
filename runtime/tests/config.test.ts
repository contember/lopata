import { test, expect, describe } from "bun:test";
import { loadConfig } from "../config";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadConfig", () => {
  test("parses valid wrangler.jsonc", async () => {
    const path = join(tmpdir(), `test-config-${Date.now()}.jsonc`);
    await Bun.write(
      path,
      `{
  // This is a comment
  "name": "test-worker",
  "main": "src/index.ts",
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }
  ],
  "r2_buckets": [
    { "binding": "R2", "bucket_name": "my-bucket" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "DO", "class_name": "MyDO" }
    ]
  },
  "workflows": [
    { "name": "wf", "binding": "WF", "class_name": "MyWF" }
  ]
}`,
    );

    const config = await loadConfig(path);
    expect(config.name).toBe("test-worker");
    expect(config.main).toBe("src/index.ts");
    expect(config.kv_namespaces!).toHaveLength(1);
    expect(config.kv_namespaces![0]!.binding).toBe("KV");
    expect(config.r2_buckets!).toHaveLength(1);
    expect(config.r2_buckets![0]!.bucket_name).toBe("my-bucket");
    expect(config.durable_objects!.bindings).toHaveLength(1);
    expect(config.durable_objects!.bindings[0]!.class_name).toBe("MyDO");
    expect(config.workflows!).toHaveLength(1);
    expect(config.workflows![0]!.class_name).toBe("MyWF");
  });

  test("handles config without optional fields", async () => {
    const path = join(tmpdir(), `test-config-minimal-${Date.now()}.jsonc`);
    await Bun.write(path, `{ "name": "minimal", "main": "index.ts" }`);

    const config = await loadConfig(path);
    expect(config.name).toBe("minimal");
    expect(config.kv_namespaces).toBeUndefined();
    expect(config.r2_buckets).toBeUndefined();
    expect(config.durable_objects).toBeUndefined();
    expect(config.workflows).toBeUndefined();
  });

  test("strips single-line comments", async () => {
    const path = join(tmpdir(), `test-config-comments-${Date.now()}.jsonc`);
    await Bun.write(
      path,
      `{
  // comment at start
  "name": "commented", // inline comment
  "main": "src/index.ts"
  // trailing comment
}`,
    );

    const config = await loadConfig(path);
    expect(config.name).toBe("commented");
  });
});
