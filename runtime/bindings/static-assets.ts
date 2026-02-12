import path from "node:path";

export interface StaticAssetsConfig {
  directory: string;
  binding?: string;
  html_handling?: "none" | "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash";
  not_found_handling?: "none" | "404-page" | "single-page-application";
}

export class StaticAssets {
  private directory: string;
  private htmlHandling: string;
  private notFoundHandling: string;

  constructor(directory: string, htmlHandling = "auto-trailing-slash", notFoundHandling = "none") {
    this.directory = directory;
    this.htmlHandling = htmlHandling;
    this.notFoundHandling = notFoundHandling;
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

    // Handle trailing slash redirects
    if (this.htmlHandling === "force-trailing-slash" && !pathname.endsWith("/") && pathname !== "/") {
      const ext = path.extname(pathname);
      if (!ext) {
        return Response.redirect(new URL(pathname + "/" + url.search, url.origin).toString(), 301);
      }
    }
    if (this.htmlHandling === "drop-trailing-slash" && pathname.endsWith("/") && pathname !== "/") {
      return Response.redirect(new URL(pathname.slice(0, -1) + url.search, url.origin).toString(), 301);
    }

    // Try to resolve the file
    const resolved = await this.resolveFile(pathname);
    if (resolved) {
      return this.serveFile(resolved);
    }

    // Not found handling
    if (this.notFoundHandling === "single-page-application") {
      const indexPath = path.join(this.directory, "index.html");
      const indexFile = Bun.file(indexPath);
      if (await indexFile.exists()) {
        return this.serveFile(indexPath);
      }
    }

    if (this.notFoundHandling === "404-page") {
      const notFoundPath = path.join(this.directory, "404.html");
      const notFoundFile = Bun.file(notFoundPath);
      if (await notFoundFile.exists()) {
        return this.serveFile(notFoundPath, 404);
      }
    }

    return new Response("Not Found", { status: 404 });
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
      const { statSync } = require("node:fs") as typeof import("node:fs");
      return statSync(filePath).isDirectory();
    } catch {
      return false;
    }
  }

  private serveFile(filePath: string, status = 200): Response {
    const file = Bun.file(filePath);
    return new Response(file, {
      status,
      headers: {
        "Content-Type": file.type,
      },
    });
  }
}
