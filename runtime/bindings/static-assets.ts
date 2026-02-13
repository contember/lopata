import path from "node:path";
import { statSync, readFileSync, existsSync } from "node:fs";

export interface StaticAssetsConfig {
  directory: string;
  binding?: string;
  html_handling?: "none" | "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash";
  not_found_handling?: "none" | "404-page" | "single-page-application";
  run_worker_first?: boolean | string[];
}

export interface StaticAssetsLimits {
  maxHeaderRules?: number;    // default 100
  maxHeaderLineLength?: number; // default 2000
}

const STATIC_ASSETS_LIMITS_DEFAULTS: Required<StaticAssetsLimits> = {
  maxHeaderRules: 100,
  maxHeaderLineLength: 2000,
};

interface HeaderRule {
  pattern: string;
  headers: Record<string, string>;
}

export class StaticAssets {
  private directory: string;
  private htmlHandling: string;
  private notFoundHandling: string;
  private limits: Required<StaticAssetsLimits>;
  private headerRules: HeaderRule[] | null = null;

  constructor(
    directory: string,
    htmlHandling = "auto-trailing-slash",
    notFoundHandling = "none",
    limits?: StaticAssetsLimits,
  ) {
    this.directory = directory;
    this.htmlHandling = htmlHandling;
    this.notFoundHandling = notFoundHandling;
    this.limits = { ...STATIC_ASSETS_LIMITS_DEFAULTS, ...limits };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);

    // Prevent path traversal — check both raw and resolved
    if (pathname.includes("..")) {
      return new Response("Bad Request", { status: 400 });
    }
    const resolvedPath = path.resolve(this.directory, "." + pathname);
    if (!resolvedPath.startsWith(this.directory)) {
      return new Response("Bad Request", { status: 400 });
    }

    // Handle trailing slash redirects (307 matches CF behavior)
    if (this.htmlHandling === "force-trailing-slash" && !pathname.endsWith("/") && pathname !== "/") {
      const ext = path.extname(pathname);
      if (!ext) {
        return Response.redirect(new URL(pathname + "/" + url.search, url.origin).toString(), 307);
      }
    }
    if (this.htmlHandling === "drop-trailing-slash" && pathname.endsWith("/") && pathname !== "/") {
      return Response.redirect(new URL(pathname.slice(0, -1) + url.search, url.origin).toString(), 307);
    }

    // Try to resolve the file
    const resolved = await this.resolveFile(pathname);
    if (resolved) {
      return this.serveFile(resolved, 200, request, pathname);
    }

    // Not found handling
    if (this.notFoundHandling === "single-page-application") {
      const indexPath = path.join(this.directory, "index.html");
      const indexFile = Bun.file(indexPath);
      if (await indexFile.exists()) {
        return this.serveFile(indexPath, 200, request, pathname);
      }
    }

    if (this.notFoundHandling === "404-page") {
      // Hierarchical 404.html: search up from the requested path
      const notFoundPath = await this.findNearest404(pathname);
      if (notFoundPath) {
        return this.serveFile(notFoundPath, 404, request, pathname);
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  private async findNearest404(pathname: string): Promise<string | null> {
    // Strip file portion to get directory path
    let dir = pathname;
    if (!dir.endsWith("/")) {
      dir = path.posix.dirname(dir);
    }

    // Walk up directory tree looking for 404.html
    while (true) {
      const candidate = path.join(this.directory, dir, "404.html");
      if (await Bun.file(candidate).exists()) {
        return candidate;
      }
      if (dir === "/" || dir === "" || dir === ".") {
        break;
      }
      dir = path.posix.dirname(dir);
    }
    return null;
  }

  private async resolveFile(pathname: string): Promise<string | null> {
    // Normalize: strip trailing slash for resolution (except root)
    if (pathname !== "/" && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    // Direct file match
    const directPath = path.join(this.directory, pathname);
    const directFile = Bun.file(directPath);
    if (await directFile.exists() && !(await this.isDirectory(directPath))) {
      return directPath;
    }

    // For root path or paths ending in /, try index.html
    if (pathname === "/" || pathname === "") {
      const indexPath = path.join(this.directory, "index.html");
      if (await Bun.file(indexPath).exists()) {
        return indexPath;
      }
      return null;
    }

    if (this.htmlHandling === "none") {
      return null;
    }

    // auto-trailing-slash: try /about/index.html, then /about.html
    // force-trailing-slash: same resolution (redirect already happened above)
    // drop-trailing-slash: same resolution (redirect already happened above)
    const indexPath = path.join(this.directory, pathname, "index.html");
    if (await Bun.file(indexPath).exists()) {
      return indexPath;
    }

    const htmlPath = directPath + ".html";
    if (await Bun.file(htmlPath).exists()) {
      return htmlPath;
    }

    return null;
  }

  private async isDirectory(filePath: string): Promise<boolean> {
    try {
      return statSync(filePath).isDirectory();
    } catch {
      return false;
    }
  }

  private computeETag(filePath: string): string {
    try {
      const stat = statSync(filePath);
      // Use mtime + size for ETag (fast, no need to hash content)
      return `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    } catch {
      return `"unknown"`;
    }
  }

  private getHeaderRules(): HeaderRule[] {
    if (this.headerRules !== null) {
      return this.headerRules;
    }

    const headersPath = path.join(this.directory, "_headers");
    if (!existsSync(headersPath)) {
      this.headerRules = [];
      return this.headerRules;
    }

    const content = readFileSync(headersPath, "utf-8");
    this.headerRules = parseHeadersFile(content, this.limits);
    return this.headerRules;
  }

  private applyHeaderRules(pathname: string, headers: Headers): void {
    const rules = this.getHeaderRules();
    for (const rule of rules) {
      if (matchPattern(rule.pattern, pathname)) {
        for (const [key, value] of Object.entries(rule.headers)) {
          headers.set(key, value);
        }
      }
    }
  }

  private serveFile(filePath: string, status: number, request?: Request, pathname?: string): Response {
    const file = Bun.file(filePath);
    const etag = this.computeETag(filePath);

    // Check If-None-Match for conditional requests
    if (request) {
      const ifNoneMatch = request.headers.get("If-None-Match");
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            "ETag": etag,
            "Cache-Control": "public, max-age=0, must-revalidate",
          },
        });
      }
    }

    const headers = new Headers({
      "Content-Type": file.type,
      "ETag": etag,
      "Cache-Control": "public, max-age=0, must-revalidate",
    });

    // Apply _headers rules
    if (pathname) {
      this.applyHeaderRules(pathname, headers);
    }

    return new Response(file, { status, headers });
  }
}

/**
 * Parse a _headers file into rules.
 * Format:
 *   /pattern
 *     Header-Name: value
 *     Another-Header: value
 */
export function parseHeadersFile(content: string, limits: Required<StaticAssetsLimits>): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let currentRule: HeaderRule | null = null;

  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.length > limits.maxHeaderLineLength) {
      continue; // skip lines exceeding limit
    }
    if (line === "" || line.startsWith("#")) {
      continue; // skip empty lines and comments
    }

    // Header line (indented with space or tab)
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (!currentRule) continue;
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (key) {
        currentRule.headers[key] = value;
      }
    } else {
      // URL pattern line
      if (rules.length >= limits.maxHeaderRules) {
        break; // reached rule limit
      }
      currentRule = { pattern: line.trim(), headers: {} };
      rules.push(currentRule);
    }
  }

  return rules;
}

/**
 * Match a URL path against a _headers pattern.
 * Supports:
 * - Exact match: /about
 * - Splats: /images/* matches /images/anything/here
 * - Placeholders: /user/:name matches /user/bob
 */
export function matchPattern(pattern: string, pathname: string): boolean {
  // Convert pattern to regex
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      regex += ".*";
    } else if (ch === ":") {
      // Placeholder — match until next /
      const rest = pattern.slice(i + 1);
      const nameEnd = rest.search(/[^a-zA-Z0-9_]/);
      if (nameEnd === -1) {
        i += rest.length;
      } else {
        i += nameEnd;
      }
      regex += "[^/]+";
    } else if (".+?^${}()|[]\\".includes(ch)) {
      regex += "\\" + ch;
    } else {
      regex += ch;
    }
  }
  regex += "$";
  return new RegExp(regex).test(pathname);
}
