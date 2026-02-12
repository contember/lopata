import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { parseDevVars, buildEnv } from "../env";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseDevVars", () => {
  test("parses simple KEY=VALUE pairs", () => {
    const result = parseDevVars("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("ignores comments and empty lines", () => {
    const result = parseDevVars("# comment\n\nFOO=bar\n  # another comment\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("strips double quotes from values", () => {
    const result = parseDevVars('SECRET="my secret value"');
    expect(result).toEqual({ SECRET: "my secret value" });
  });

  test("strips single quotes from values", () => {
    const result = parseDevVars("SECRET='my secret value'");
    expect(result).toEqual({ SECRET: "my secret value" });
  });

  test("handles values with equals signs", () => {
    const result = parseDevVars("URL=https://example.com?a=1&b=2");
    expect(result).toEqual({ URL: "https://example.com?a=1&b=2" });
  });

  test("trims whitespace around keys and values", () => {
    const result = parseDevVars("  FOO  =  bar  ");
    expect(result).toEqual({ FOO: "bar" });
  });

  test("ignores lines without equals sign", () => {
    const result = parseDevVars("INVALID_LINE\nFOO=bar");
    expect(result).toEqual({ FOO: "bar" });
  });

  test("returns empty object for empty input", () => {
    expect(parseDevVars("")).toEqual({});
    expect(parseDevVars("  \n  \n")).toEqual({});
  });
});

describe("buildEnv - environment variables", () => {
  test("injects vars from config into env", () => {
    const { env } = buildEnv({
      name: "test",
      main: "index.ts",
      vars: { API_HOST: "https://api.example.com", ENVIRONMENT: "development" },
    });
    expect(env.API_HOST).toBe("https://api.example.com");
    expect(env.ENVIRONMENT).toBe("development");
  });

  test("works with no vars in config", () => {
    const { env } = buildEnv({ name: "test", main: "index.ts" });
    // Should not throw, env should still be a valid object
    expect(env).toBeDefined();
  });

  test("reads .dev.vars file and merges into env", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bunflare-test-"));
    const devVarsPath = join(tmpDir, ".dev.vars");
    writeFileSync(devVarsPath, "SECRET_KEY=supersecret\nDB_URL=postgres://localhost/test");

    const { env } = buildEnv({ name: "test", main: "index.ts" }, devVarsPath);
    expect(env.SECRET_KEY).toBe("supersecret");
    expect(env.DB_URL).toBe("postgres://localhost/test");

    rmSync(tmpDir, { recursive: true });
  });

  test(".dev.vars overrides vars from config", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bunflare-test-"));
    const devVarsPath = join(tmpDir, ".dev.vars");
    writeFileSync(devVarsPath, "API_HOST=http://localhost:3000");

    const { env } = buildEnv(
      {
        name: "test",
        main: "index.ts",
        vars: { API_HOST: "https://api.example.com", KEEP_ME: "yes" },
      },
      devVarsPath,
    );
    expect(env.API_HOST).toBe("http://localhost:3000");
    expect(env.KEEP_ME).toBe("yes");

    rmSync(tmpDir, { recursive: true });
  });

  test("handles non-existent .dev.vars gracefully", () => {
    const { env } = buildEnv(
      {
        name: "test",
        main: "index.ts",
        vars: { FOO: "bar" },
      },
      "/tmp/nonexistent-devvars-file",
    );
    expect(env.FOO).toBe("bar");
  });
});
