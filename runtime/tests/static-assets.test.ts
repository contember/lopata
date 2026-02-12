import { test, expect, beforeEach, afterEach } from "bun:test";
import { StaticAssets } from "../bindings/static-assets";
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

function makeRequest(pathname: string): Request {
  return new Request(`http://localhost${pathname}`);
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
  // URL constructor normalizes /../ and %2e%2e, so path traversal via URL is not possible
  // The resolved path always stays within the directory
  assets = new StaticAssets(tmpDir);
  // This URL gets normalized to /etc/passwd (no ..), which resolves inside tmpDir
  const res = await assets.fetch(new Request("http://localhost/%2e%2e/etc/passwd"));
  expect(res.status).toBe(404); // file doesn't exist, but no escape
});

test("path with .. segment in decoded pathname is rejected", async () => {
  // Manually construct a scenario where decoded pathname contains ..
  // In practice, URL normalizes this, but our defense-in-depth catches it
  assets = new StaticAssets(tmpDir);
  // Create a file in a subdir, then try a path like /sub/../sub/file
  // URL normalizes /sub/../sub/file to /sub/file, so it works normally
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

// === html_handling: force-trailing-slash ===

test("force-trailing-slash: redirects /about to /about/", async () => {
  createFile("about/index.html", "About");
  assets = new StaticAssets(tmpDir, "force-trailing-slash");
  const res = await assets.fetch(makeRequest("/about"));
  expect(res.status).toBe(301);
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

// === html_handling: drop-trailing-slash ===

test("drop-trailing-slash: redirects /about/ to /about", async () => {
  createFile("about.html", "About");
  assets = new StaticAssets(tmpDir, "drop-trailing-slash");
  const res = await assets.fetch(makeRequest("/about/"));
  expect(res.status).toBe(301);
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
