import type { HandlerContext } from "./types";
import { handlers as overview } from "./handlers/overview";
import { handlers as kv } from "./handlers/kv";
import { handlers as r2 } from "./handlers/r2";
import { handlers as queue } from "./handlers/queue";
import { handlers as durableObjects } from "./handlers/do";
import { handlers as workflows } from "./handlers/workflows";
import { handlers as d1 } from "./handlers/d1";
import { handlers as cache } from "./handlers/cache";
import { handlers as generations } from "./handlers/generations";
import { handlers as workers } from "./handlers/workers";
import { handlers as containers } from "./handlers/containers";
import { handlers as traces } from "./handlers/traces";
import { handlers as config } from "./handlers/config";
import { handlers as errors } from "./handlers/errors";
import { handlers as scheduled } from "./handlers/scheduled";
import { handlers as email } from "./handlers/email";
import { handlers as ai } from "./handlers/ai";
import { handlers as analyticsEngine } from "./handlers/analytics-engine";

const allHandlers = {
  ...overview,
  ...kv,
  ...r2,
  ...queue,
  ...durableObjects,
  ...workflows,
  ...d1,
  ...cache,
  ...generations,
  ...workers,
  ...containers,
  ...traces,
  ...config,
  ...errors,
  ...scheduled,
  ...email,
  ...ai,
  ...analyticsEngine,
};

export type Procedures = {
  [K in keyof typeof allHandlers]: {
    input: Parameters<(typeof allHandlers)[K]>[0];
    output: Awaited<ReturnType<(typeof allHandlers)[K]>>;
  };
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function dispatch(request: Request, ctx: HandlerContext): Promise<Response> {
  try {
    const body = await request.json() as { procedure: string; input: unknown };
    if (!body.procedure || typeof body.procedure !== "string") {
      return json({ error: "procedure must be a string" }, 400);
    }
    const handler = allHandlers[body.procedure as keyof typeof allHandlers];
    if (!handler) return json({ error: `Unknown procedure: ${body.procedure}` }, 404);
    const result = await (handler as Function)(body.input ?? {}, ctx);
    return json(result);
  } catch (err) {
    console.error("[bunflare dashboard] RPC error:", err);
    return json({ error: String(err) }, 500);
  }
}
