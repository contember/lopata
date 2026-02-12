export { Counter } from "./counter";
export { MyWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // GET /
    if (path === "/" && method === "GET") {
      return Response.json({ status: "ok" });
    }

    // KV routes: GET/PUT /kv/:key
    const kvMatch = path.match(/^\/kv\/([^/]+)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      if (method === "GET") {
        const value = await env.KV.get(key);
        if (value === null) return new Response("Not found", { status: 404 });
        return new Response(value);
      }
      if (method === "PUT") {
        const body = await request.text();
        await env.KV.put(key, body);
        return new Response("OK", { status: 201 });
      }
    }

    // R2 routes: GET/PUT /r2/:key
    const r2Match = path.match(/^\/r2\/([^/]+)$/);
    if (r2Match) {
      const key = r2Match[1]!;
      if (method === "GET") {
        const object = await env.R2.get(key);
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(object.body);
      }
      if (method === "PUT") {
        const body = await request.arrayBuffer();
        await env.R2.put(key, body);
        return new Response("OK", { status: 201 });
      }
    }

    // Counter DO routes
    const counterGetMatch = path.match(/^\/counter\/([^/]+)$/);
    if (counterGetMatch && method === "GET") {
      const id = env.COUNTER.idFromName(counterGetMatch[1]!);
      const stub = env.COUNTER.get(id);
      const count = await stub.getCount();
      return Response.json({ count });
    }

    const counterIncMatch = path.match(/^\/counter\/([^/]+)\/increment$/);
    if (counterIncMatch && method === "POST") {
      const id = env.COUNTER.idFromName(counterIncMatch[1]!);
      const stub = env.COUNTER.get(id);
      const count = await stub.increment();
      return Response.json({ count });
    }

    // Workflow: POST /workflow
    if (path === "/workflow" && method === "POST") {
      const body = (await request.json()) as { input: string };
      const instance = await env.MY_WORKFLOW.create({ params: { input: body.input } });
      return Response.json({ id: instance.id });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
