import { join } from "node:path";
import type { WranglerConfig } from "../config";
import { getTraceStore } from "../tracing/store";
import { getActiveContext } from "../tracing/context";

interface StackFrame {
  file: string;
  line: number;
  column: number;
  function: string;
  source?: string[];
  sourceLine?: number;
}

interface ErrorPageData {
  error: {
    name: string;
    message: string;
    stack: string;
    frames: StackFrame[];
  };
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  env: Record<string, string>;
  bindings: { name: string; type: string }[];
  runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
    workerName?: string;
    configName?: string;
  };
}

// ─── Pre-built error page HTML ────────────────────────────────────────────

let errorPageHtml: string | null = null;
let errorPageAssets: Map<string, { content: Uint8Array; contentType: string }> | null = null;

async function buildErrorPage(): Promise<void> {
  const tailwindPlugin = (await import("bun-plugin-tailwind")).default;
  const htmlEntry = join(import.meta.dir, "index.html");

  const result = await Bun.build({
    entrypoints: [htmlEntry],
    plugins: [tailwindPlugin],
  });

  if (!result.success) {
    console.error("[bunflare] Error page build failed:", result.logs);
    throw new Error("Error page build failed");
  }

  const assets = new Map<string, { content: Uint8Array; contentType: string }>();
  let html = "";

  for (const output of result.outputs) {
    const name = output.path.split("/").pop()!;
    const content = new Uint8Array(await output.arrayBuffer());

    if (output.kind === "entry-point" && name.endsWith(".html")) {
      html = new TextDecoder().decode(content);
    } else {
      const contentType = name.endsWith(".css")
        ? "text/css"
        : name.endsWith(".js")
          ? "application/javascript"
          : "application/octet-stream";
      assets.set(name, { content, contentType });
    }
  }

  // Inline assets directly into the HTML to make it self-contained
  for (const [name, asset] of assets) {
    const assetText = new TextDecoder().decode(asset.content);
    if (name.endsWith(".css")) {
      html = html.replace(
        new RegExp(`<link[^>]*href="\\./${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/?>`),
        `<style>${assetText}</style>`,
      );
    } else if (name.endsWith(".js")) {
      html = html.replace(
        new RegExp(`<script[^>]*src="\\./${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>[^<]*</script>`),
        `<script type="module">${assetText}</script>`,
      );
    }
  }

  errorPageHtml = html;
  errorPageAssets = assets;
}

await buildErrorPage();

// ─── Stack trace parsing ──────────────────────────────────────────────────

const STACK_LINE_RE = /at\s+(?:(.+?)\s+\()?(.+):(\d+):(\d+)\)?/;

function parseStackFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = line.match(STACK_LINE_RE);
    if (!match) continue;
    frames.push({
      file: match[2]!,
      line: parseInt(match[3]!, 10),
      column: parseInt(match[4]!, 10),
      function: match[1] ?? "(anonymous)",
    });
  }
  return frames;
}

async function enrichFrameWithSource(frame: StackFrame): Promise<void> {
  try {
    const file = Bun.file(frame.file);
    if (!await file.exists()) return;
    const text = await file.text();
    const lines = text.split("\n");
    const contextRadius = 7;
    const start = Math.max(0, frame.line - 1 - contextRadius);
    const end = Math.min(lines.length, frame.line + contextRadius);
    frame.source = lines.slice(start, end);
    frame.sourceLine = frame.line - 1 - start;
  } catch {
    // File unreadable — skip source preview
  }
}

// ─── Env masking ──────────────────────────────────────────────────────────

const SENSITIVE_KEYS = /SECRET|KEY|TOKEN|PASSWORD|API|PRIVATE/i;

function maskEnv(env: Record<string, unknown>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "object") continue; // skip bindings
    const strVal = String(value);
    masked[key] = SENSITIVE_KEYS.test(key) ? "***" : strVal;
  }
  return masked;
}

// ─── Binding extraction ──────────────────────────────────────────────────

function extractBindings(config: WranglerConfig): { name: string; type: string }[] {
  const bindings: { name: string; type: string }[] = [];
  for (const kv of config.kv_namespaces ?? []) bindings.push({ name: kv.binding, type: "KV" });
  for (const r2 of config.r2_buckets ?? []) bindings.push({ name: r2.binding, type: "R2" });
  for (const d of config.durable_objects?.bindings ?? []) bindings.push({ name: d.name, type: "Durable Object" });
  for (const wf of config.workflows ?? []) bindings.push({ name: wf.binding, type: "Workflow" });
  for (const d1 of config.d1_databases ?? []) bindings.push({ name: d1.binding, type: "D1" });
  for (const p of config.queues?.producers ?? []) bindings.push({ name: p.binding, type: "Queue" });
  for (const svc of config.services ?? []) bindings.push({ name: svc.binding, type: "Service" });
  if (config.images) bindings.push({ name: config.images.binding, type: "Images" });
  if (config.assets?.binding) bindings.push({ name: config.assets.binding, type: "Assets" });
  return bindings;
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function renderErrorPage(
  error: unknown,
  request: Request,
  env: Record<string, unknown>,
  config: WranglerConfig,
  workerName?: string,
): Promise<Response> {
  if (!errorPageHtml) {
    return new Response("Internal Server Error", { status: 500 });
  }

  const err = error instanceof Error ? error : new Error(String(error));
  const frames = parseStackFrames(err.stack ?? "");

  // Enrich frames with source code (limit to 10 for performance)
  const framesToEnrich = frames.slice(0, 10);
  await Promise.all(framesToEnrich.map(enrichFrameWithSource));

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const data: ErrorPageData = {
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack ?? String(error),
      frames: framesToEnrich.filter(f => f.source),
    },
    request: {
      method: request.method,
      url: request.url,
      headers,
    },
    env: maskEnv(env),
    bindings: extractBindings(config),
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
      workerName,
      configName: config.name,
    },
  };

  // Persist error to tracing store
  try {
    const ctx = getActiveContext();
    getTraceStore().insertError({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      errorName: data.error.name,
      errorMessage: data.error.message,
      requestMethod: data.request.method,
      requestUrl: data.request.url,
      workerName: data.runtime.workerName ?? null,
      traceId: ctx?.traceId ?? null,
      spanId: ctx?.spanId ?? null,
      source: "fetch",
      data: JSON.stringify(data),
    });
  } catch {
    // Don't let persistence failure break the error response
  }

  const script = `<script>window.__BUNFLARE_ERROR__ = ${JSON.stringify(data).replace(/</g, "\\u003c")};</script>`;
  const html = errorPageHtml.replace("</head>", `${script}\n</head>`);

  return new Response(html, {
    status: 500,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
