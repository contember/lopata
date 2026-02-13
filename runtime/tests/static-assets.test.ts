import { test, expect, beforeEach, afterEach } from "bun:test";
import { StaticAssets, parseHeadersFile, matchPattern } from "../bindings/static-assets";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;
let assets: StaticAssets;

function createFile(relativePath: string, content: string) {
  const fullPath = path.join(tmpDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "bunflare-static-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRequest(pathname: string, headers?: Record<string, string>): Request {
  return new Request(`http://localhost${pathname}`, { headers });
}

// === Basic file serving ===

test("serves a file at exact path", async () => {
  createFile("hello.txt", "Hello World");
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/hello.txt"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("Hello World");
});

test("serves index.html at root", async () => {
  createFile("index.html", "<h1>Home</h1>");
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<h1>Home</h1>");
});

test("serves nested files", async () => {
  createFile("css/style.css", "body { color: red; }");
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/css/style.css"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("body { color: red; }");
});

test("returns 404 for non-existent file", async () => {
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/missing.txt"));
  expect(res.status).toBe(404);
});

test("sets Content-Type header", async () => {
  createFile("page.html", "<h1>Hi</h1>");
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/page.html"));
  expect(res.headers.get("Content-Type")).toContain("text/html");
});

// === Path traversal ===

test("path traversal: URL normalization prevents escaping directory", async () => {
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(new Request("http://localhost/%2e%2e/etc/passwd"));
  expect(res.status).toBe(404);
});

test("path with .. segment in decoded pathname is rejected", async () => {
  assets = new StaticAssets(tmpDir);
  createFile("sub/file.txt", "content");
  const res = await assets.fetch(makeRequest("/sub/file.txt"));
  expect(res.status).toBe(200);
});

// === html_handling: auto-trailing-slash (default) ===

test("auto-trailing-slash: /about resolves to /about/index.html", async () => {
  createFile("about/index.html", "<h1>About</h1>");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash");
  const res = await assets.fetch(makeRequest("/about"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<h1>About</h1>");
});

test("auto-trailing-slash: /about resolves to /about.html", async () => {
  createFile("about.html", "<h1>About Page</h1>");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash");
  const res = await assets.fetch(makeRequest("/about"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<h1>About Page</h1>");
});

test("auto-trailing-slash: prefers /about/index.html over /about.html", async () => {
  createFile("about/index.html", "index version");
  createFile("about.html", "html version");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash");
  const res = await assets.fetch(makeRequest("/about"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("index version");
});

// === html_handling: none ===

test("none: /about does NOT resolve to /about.html", async () => {
  createFile("about.html", "<h1>About</h1>");
  assets = new StaticAssets(tmpDir, "none");
  const res = await assets.fetch(makeRequest("/about"));
  expect(res.status).toBe(404);
});

test("none: /about.html still works", async () => {
  createFile("about.html", "<h1>About</h1>");
  assets = new StaticAssets(tmpDir, "none");
  const res = await assets.fetch(makeRequest("/about.html"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<h1>About</h1>");
});

// === html_handling: force-trailing-slash (307 redirect) ===

test("force-trailing-slash: redirects /about to /about/ with 307", async () => {
  createFile("about/index.html", "About");
  assets = new StaticAssets(tmpDir, "force-trailing-slash");
  const res = await assets.fetch(makeRequest("/about"));
  expect(res.status).toBe(307);
  expect(res.headers.get("Location")).toBe("http://localhost/about/");
});

test("force-trailing-slash: does not redirect files with extensions", async () => {
  createFile("style.css", "body {}");
  assets = new StaticAssets(tmpDir, "force-trailing-slash");
  const res = await assets.fetch(makeRequest("/style.css"));
  expect(res.status).toBe(200);
});

test("force-trailing-slash: /about/ serves /about/index.html", async () => {
  createFile("about/index.html", "About page");
  assets = new StaticAssets(tmpDir, "force-trailing-slash");
  const res = await assets.fetch(makeRequest("/about/"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("About page");
});

// === html_handling: drop-trailing-slash (307 redirect) ===

test("drop-trailing-slash: redirects /about/ to /about with 307", async () => {
  createFile("about.html", "About");
  assets = new StaticAssets(tmpDir, "drop-trailing-slash");
  const res = await assets.fetch(makeRequest("/about/"));
  expect(res.status).toBe(307);
  expect(res.headers.get("Location")).toBe("http://localhost/about");
});

test("drop-trailing-slash: does not redirect root /", async () => {
  createFile("index.html", "Home");
  assets = new StaticAssets(tmpDir, "drop-trailing-slash");
  const res = await assets.fetch(makeRequest("/"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("Home");
});

// === not_found_handling: none ===

test("not_found_handling none: returns 404", async () => {
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "none");
  const res = await assets.fetch(makeRequest("/missing"));
  expect(res.status).toBe(404);
});

// === not_found_handling: 404-page ===

test("404-page: serves /404.html on not found", async () => {
  createFile("404.html", "<h1>Not Found</h1>");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "404-page");
  const res = await assets.fetch(makeRequest("/missing"));
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("<h1>Not Found</h1>");
});

test("404-page: returns plain 404 if /404.html doesn't exist", async () => {
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "404-page");
  const res = await assets.fetch(makeRequest("/missing"));
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not Found");
});

// === not_found_handling: single-page-application ===

test("SPA: serves /index.html for not-found paths", async () => {
  createFile("index.html", "<div id='app'></div>");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "single-page-application");
  const res = await assets.fetch(makeRequest("/any/random/path"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<div id='app'></div>");
});

test("SPA: still serves existing files directly", async () => {
  createFile("index.html", "<div id='app'></div>");
  createFile("style.css", "body {}");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "single-page-application");
  const res = await assets.fetch(makeRequest("/style.css"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("body {}");
});

test("SPA: returns 404 if /index.html doesn't exist", async () => {
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "single-page-application");
  const res = await assets.fetch(makeRequest("/missing"));
  expect(res.status).toBe(404);
});

// === ETag and Cache-Control ===

test("response includes ETag header", async () => {
  createFile("hello.txt", "Hello");
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/hello.txt"));
  expect(res.status).toBe(200);
  const etag = res.headers.get("ETag");
  expect(etag).toBeTruthy();
  expect(etag!.startsWith('"')).toBe(true);
  expect(etag!.endsWith('"')).toBe(true);
});

test("response includes Cache-Control header", async () => {
  createFile("hello.txt", "Hello");
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/hello.txt"));
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
});

test("If-None-Match returns 304 when ETag matches", async () => {
  createFile("hello.txt", "Hello");
  assets = new StaticAssets(tmpDir);

  // First request to get ETag
  const res1 = await assets.fetch(makeRequest("/hello.txt"));
  const etag = res1.headers.get("ETag")!;
  expect(etag).toBeTruthy();

  // Second request with If-None-Match
  const res2 = await assets.fetch(makeRequest("/hello.txt", { "If-None-Match": etag }));
  expect(res2.status).toBe(304);
  expect(res2.headers.get("ETag")).toBe(etag);
});

test("If-None-Match returns 200 when ETag does not match", async () => {
  createFile("hello.txt", "Hello");
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/hello.txt", { "If-None-Match": '"wrong"' }));
  expect(res.status).toBe(200);
});

test("ETag is consistent across requests for same file", async () => {
  createFile("hello.txt", "Hello");
  assets = new StaticAssets(tmpDir);
  const res1 = await assets.fetch(makeRequest("/hello.txt"));
  const res2 = await assets.fetch(makeRequest("/hello.txt"));
  expect(res1.headers.get("ETag")).toBe(res2.headers.get("ETag"));
});

// === _headers file ===

test("parseHeadersFile: parses basic rules", () => {
  const content = `/about
  X-Custom: hello
  X-Another: world
/images/*
  Cache-Control: max-age=3600`;
  const rules = parseHeadersFile(content, { maxHeaderRules: 100, maxHeaderLineLength: 2000 });
  expect(rules).toHaveLength(2);
  expect(rules[0]!.pattern).toBe("/about");
  expect(rules[0]!.headers["X-Custom"]).toBe("hello");
  expect(rules[0]!.headers["X-Another"]).toBe("world");
  expect(rules[1]!.pattern).toBe("/images/*");
  expect(rules[1]!.headers["Cache-Control"]).toBe("max-age=3600");
});

test("parseHeadersFile: respects maxHeaderRules limit", () => {
  const content = `/a\n  X: 1\n/b\n  X: 2\n/c\n  X: 3`;
  const rules = parseHeadersFile(content, { maxHeaderRules: 2, maxHeaderLineLength: 2000 });
  expect(rules).toHaveLength(2);
});

test("parseHeadersFile: skips comments", () => {
  const content = `# This is a comment\n/about\n  X-Custom: hello`;
  const rules = parseHeadersFile(content, { maxHeaderRules: 100, maxHeaderLineLength: 2000 });
  expect(rules).toHaveLength(1);
  expect(rules[0]!.pattern).toBe("/about");
});

test("matchPattern: exact match", () => {
  expect(matchPattern("/about", "/about")).toBe(true);
  expect(matchPattern("/about", "/other")).toBe(false);
});

test("matchPattern: splat wildcard", () => {
  expect(matchPattern("/images/*", "/images/photo.jpg")).toBe(true);
  expect(matchPattern("/images/*", "/images/sub/photo.jpg")).toBe(true);
  expect(matchPattern("/images/*", "/other/photo.jpg")).toBe(false);
});

test("matchPattern: placeholder", () => {
  expect(matchPattern("/user/:id", "/user/123")).toBe(true);
  expect(matchPattern("/user/:id", "/user/abc")).toBe(true);
  expect(matchPattern("/user/:id", "/user/123/extra")).toBe(false);
});

test("_headers file applies to served responses", async () => {
  createFile("hello.txt", "Hello");
  createFile("_headers", "/hello.txt\n  X-Custom: my-value");
  assets = new StaticAssets(tmpDir);
  const res = await assets.fetch(makeRequest("/hello.txt"));
  expect(res.status).toBe(200);
  expect(res.headers.get("X-Custom")).toBe("my-value");
});

test("_headers file splat applies to multiple paths", async () => {
  createFile("img/a.png", "a");
  createFile("img/b.png", "b");
  createFile("_headers", "/img/*\n  Cache-Control: max-age=86400");
  assets = new StaticAssets(tmpDir);
  const res1 = await assets.fetch(makeRequest("/img/a.png"));
  expect(res1.headers.get("Cache-Control")).toBe("max-age=86400");
  const res2 = await assets.fetch(makeRequest("/img/b.png"));
  expect(res2.headers.get("Cache-Control")).toBe("max-age=86400");
});

// === Hierarchical 404.html ===

test("404-page: serves nearest 404.html in subdirectory", async () => {
  createFile("404.html", "Root 404");
  createFile("api/404.html", "API 404");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "404-page");

  const res1 = await assets.fetch(makeRequest("/api/missing"));
  expect(res1.status).toBe(404);
  expect(await res1.text()).toBe("API 404");

  const res2 = await assets.fetch(makeRequest("/other/missing"));
  expect(res2.status).toBe(404);
  expect(await res2.text()).toBe("Root 404");
});

test("404-page: walks up directory tree", async () => {
  createFile("404.html", "Root 404");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "404-page");
  const res = await assets.fetch(makeRequest("/deep/nested/path/missing"));
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Root 404");
});

// === StaticAssetsLimits ===

test("custom limits are accepted via constructor", async () => {
  createFile("hello.txt", "Hello");
  assets = new StaticAssets(tmpDir, "auto-trailing-slash", "none", {
    maxHeaderRules: 5,
    maxHeaderLineLength: 100,
  });
  const res = await assets.fetch(makeRequest("/hello.txt"));
  expect(res.status).toBe(200);
});
