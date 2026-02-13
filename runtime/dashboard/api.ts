import type { WranglerConfig } from "../config";
import type { GenerationManager } from "../generation-manager";
import type { WorkerRegistry } from "../worker-registry";
import type { HandlerContext } from "./rpc/types";
import { dispatch } from "./rpc/server";

const ctx: HandlerContext = { config: null, manager: null, registry: null };

export function setDashboardConfig(config: WranglerConfig): void {
  ctx.config = config;
}

export function setGenerationManager(manager: GenerationManager): void {
  ctx.manager = manager;
}

export function setWorkerRegistry(registry: WorkerRegistry): void {
  ctx.registry = registry;
}

// Dashboard HTML — must be used in Bun.serve routes (not fetch) for proper bundling
export { default as dashboardHtml } from "./index.html";

export function handleDashboardRequest(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/__dashboard/api/rpc" && request.method === "POST") {
    return dispatch(request, ctx);
  }

  return new Response("Not found", { status: 404 });
}
