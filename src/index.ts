export { Counter } from "./counter";
export { MyWorkflow } from "./workflow";

function html(body: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bunflare Playground</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #0a0a0a; color: #e0e0e0; }
  h1 { margin-bottom: 0.5rem; color: #f97316; }
  h2 { margin: 2rem 0 0.75rem; color: #fb923c; border-bottom: 1px solid #333; padding-bottom: 0.25rem; }
  .subtitle { color: #888; margin-bottom: 2rem; }
  .section { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
  a { color: #60a5fa; }
  form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; margin-top: 0.75rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: #aaa; }
  input, textarea { background: #222; border: 1px solid #444; border-radius: 4px; padding: 0.4rem 0.6rem; color: #eee; font-family: monospace; }
  textarea { min-height: 60px; min-width: 250px; }
  button { background: #f97316; color: #000; font-weight: 600; border: none; border-radius: 4px; padding: 0.5rem 1rem; cursor: pointer; }
  button:hover { background: #fb923c; }
  button.danger { background: #ef4444; color: #fff; }
  button.danger:hover { background: #f87171; }
  button.secondary { background: #333; color: #ddd; }
  button.secondary:hover { background: #444; }
  #result { margin-top: 1.5rem; background: #111; border: 1px solid #333; border-radius: 8px; padding: 1rem; white-space: pre-wrap; font-family: monospace; font-size: 0.9rem; display: none; }
  .result-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .status { font-size: 0.8rem; padding: 0.2rem 0.5rem; border-radius: 4px; }
  .status.ok { background: #166534; color: #4ade80; }
  .status.err { background: #7f1d1d; color: #fca5a5; }
  .links { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem; }
  .links a { font-size: 0.85rem; background: #222; padding: 0.3rem 0.6rem; border-radius: 4px; text-decoration: none; }
  .links a:hover { background: #333; }
</style>
</head><body>
${body}
<div id="result"><div class="result-header"><span id="result-label">Response</span><span id="result-status" class="status"></span></div><pre id="result-body"></pre></div>
<script>
async function api(method, path, body) {
  const el = document.getElementById('result');
  const bodyEl = document.getElementById('result-body');
  const labelEl = document.getElementById('result-label');
  const statusEl = document.getElementById('result-status');
  el.style.display = 'block';
  labelEl.textContent = method + ' ' + path;
  bodyEl.textContent = 'Loading...';
  statusEl.textContent = '';
  statusEl.className = 'status';
  try {
    const opts = { method };
    if (body !== undefined) {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (typeof body !== 'string') opts.headers = { 'Content-Type': 'application/json' };
    }
    const res = await fetch(path, opts);
    statusEl.textContent = res.status + ' ' + res.statusText;
    statusEl.classList.add(res.ok ? 'ok' : 'err');
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      bodyEl.textContent = JSON.stringify(await res.json(), null, 2);
    } else {
      bodyEl.textContent = await res.text();
    }
  } catch(e) {
    statusEl.textContent = 'Error';
    statusEl.classList.add('err');
    bodyEl.textContent = e.message;
  }
}
function formVal(id) { return document.getElementById(id).value; }
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function indexPage(): Response {
  return html(`
<h1>Bunflare Playground</h1>
<p class="subtitle">Local Cloudflare Worker runtime — test all bindings below</p>

<h2>KV Store</h2>
<div class="section">
  <div class="links">
    <a href="#" onclick="api('GET','/kv/test-key');return false">GET /kv/test-key</a>
    <a href="#" onclick="api('GET','/kv?list=1');return false">LIST all keys</a>
  </div>
  <form onsubmit="api('PUT','/kv/'+formVal('kv-key'),formVal('kv-val'));return false">
    <label>Key <input id="kv-key" value="test-key"></label>
    <label>Value <input id="kv-val" value="hello world"></label>
    <button type="submit">PUT</button>
  </form>
  <form onsubmit="api('GET','/kv/'+formVal('kv-get-key'));return false" style="margin-top:0.5rem">
    <label>Key <input id="kv-get-key" value="test-key"></label>
    <button type="submit" class="secondary">GET</button>
  </form>
  <form onsubmit="api('DELETE','/kv/'+formVal('kv-del-key'));return false" style="margin-top:0.5rem">
    <label>Key <input id="kv-del-key" value="test-key"></label>
    <button type="submit" class="danger">DELETE</button>
  </form>
</div>

<h2>R2 Bucket</h2>
<div class="section">
  <div class="links">
    <a href="#" onclick="api('GET','/r2?list=1');return false">LIST objects</a>
    <a href="#" onclick="api('GET','/r2/demo.txt');return false">GET /r2/demo.txt</a>
  </div>
  <form onsubmit="api('PUT','/r2/'+formVal('r2-key'),formVal('r2-val'));return false">
    <label>Key <input id="r2-key" value="demo.txt"></label>
    <label>Value <textarea id="r2-val">Hello from R2!</textarea></label>
    <button type="submit">PUT</button>
  </form>
  <form onsubmit="api('GET','/r2/'+formVal('r2-get-key'));return false" style="margin-top:0.5rem">
    <label>Key <input id="r2-get-key" value="demo.txt"></label>
    <button type="submit" class="secondary">GET</button>
  </form>
  <form onsubmit="api('DELETE','/r2/'+formVal('r2-del-key'));return false" style="margin-top:0.5rem">
    <label>Key <input id="r2-del-key" value="demo.txt"></label>
    <button type="submit" class="danger">DELETE</button>
  </form>
</div>

<h2>D1 Database</h2>
<div class="section">
  <div class="links">
    <a href="#" onclick="api('POST','/d1/exec',{sql:'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL)'});return false">Create table</a>
    <a href="#" onclick="api('GET','/d1/query?sql='+encodeURIComponent('SELECT * FROM users'));return false">SELECT * FROM users</a>
    <a href="#" onclick="api('GET','/d1/tables');return false">List tables</a>
  </div>
  <form onsubmit="api('POST','/d1/query',{sql:formVal('d1-sql'),params:formVal('d1-params')?JSON.parse(formVal('d1-params')):[]});return false">
    <label>SQL <textarea id="d1-sql">INSERT INTO users (name, email) VALUES (?, ?)</textarea></label>
    <label>Params (JSON array) <input id="d1-params" value='["Alice","alice@example.com"]'></label>
    <button type="submit">Execute</button>
  </form>
</div>

<h2>Durable Object — Counter</h2>
<div class="section">
  <form onsubmit="api('GET','/counter/'+formVal('do-name'));return false">
    <label>Name <input id="do-name" value="my-counter"></label>
    <button type="submit" class="secondary">GET count</button>
    <button type="button" onclick="api('POST','/counter/'+formVal('do-name')+'/increment')">INCREMENT</button>
    <button type="button" onclick="api('POST','/counter/'+formVal('do-name')+'/decrement')">DECREMENT</button>
    <button type="button" class="danger" onclick="api('POST','/counter/'+formVal('do-name')+'/reset')">RESET</button>
  </form>
</div>

<h2>Queue</h2>
<div class="section">
  <form onsubmit="api('POST','/queue/send',JSON.parse(formVal('q-body')));return false">
    <label>Message body (JSON) <textarea id="q-body">{"event":"test","ts":${Date.now()}}</textarea></label>
    <button type="submit">Send message</button>
  </form>
  <form onsubmit="api('POST','/queue/send-batch',JSON.parse(formVal('q-batch')));return false" style="margin-top:0.5rem">
    <label>Batch (JSON array) <textarea id="q-batch">[{"body":{"n":1}},{"body":{"n":2}},{"body":{"n":3}}]</textarea></label>
    <button type="submit">Send batch</button>
  </form>
</div>

<h2>Workflow</h2>
<div class="section">
  <form onsubmit="api('POST','/workflow',{input:formVal('wf-input')});return false">
    <label>Input <input id="wf-input" value="hello workflow"></label>
    <button type="submit">Create instance</button>
  </form>
  <form onsubmit="api('GET','/workflow/'+formVal('wf-id'));return false" style="margin-top:0.5rem">
    <label>Instance ID <input id="wf-id" placeholder="paste instance id"></label>
    <button type="submit" class="secondary">Get status</button>
  </form>
</div>
  `);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── Index ──
    if (path === "/" && method === "GET") {
      return indexPage();
    }

    // ── KV ──
    if (path === "/kv" && method === "GET") {
      const list = await env.KV.list();
      return Response.json(list);
    }
    const kvMatch = path.match(/^\/kv\/(.+)$/);
    if (kvMatch) {
      const key = decodeURIComponent(kvMatch[1]!);
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
      if (method === "DELETE") {
        await env.KV.delete(key);
        return new Response("Deleted", { status: 200 });
      }
    }

    // ── R2 ──
    if (path === "/r2" && method === "GET") {
      const list = await env.R2.list();
      return Response.json({
        objects: list.objects.map((o) => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
        })),
        truncated: list.truncated,
      });
    }
    const r2Match = path.match(/^\/r2\/(.+)$/);
    if (r2Match) {
      const key = decodeURIComponent(r2Match[1]!);
      if (method === "GET") {
        const object = await env.R2.get(key);
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(object.body, {
          headers: {
            "Content-Type":
              object.httpMetadata?.contentType ??
              "application/octet-stream",
            "ETag": object.etag,
          },
        });
      }
      if (method === "PUT") {
        const body = await request.arrayBuffer();
        const ct = request.headers.get("content-type");
        await env.R2.put(key, body, {
          httpMetadata: ct ? { contentType: ct } : undefined,
        });
        return new Response("OK", { status: 201 });
      }
      if (method === "DELETE") {
        await env.R2.delete(key);
        return new Response("Deleted", { status: 200 });
      }
    }

    // ── D1 ──
    if (path === "/d1/tables" && method === "GET") {
      const result = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      ).all();
      return Response.json(result);
    }
    if (path === "/d1/query" && method === "GET") {
      const sql = url.searchParams.get("sql");
      if (!sql) return new Response("Missing sql param", { status: 400 });
      const result = await env.DB.prepare(sql).all();
      return Response.json(result);
    }
    if (path === "/d1/query" && method === "POST") {
      const body = (await request.json()) as { sql: string; params?: unknown[] };
      const stmt = body.params?.length
        ? env.DB.prepare(body.sql).bind(...body.params)
        : env.DB.prepare(body.sql);
      const result = await stmt.all();
      return Response.json(result);
    }
    if (path === "/d1/exec" && method === "POST") {
      const body = (await request.json()) as { sql: string };
      const result = await env.DB.exec(body.sql);
      return Response.json(result);
    }

    // ── Counter DO ──
    const counterMatch = path.match(/^\/counter\/([^/]+)(\/(.+))?$/);
    if (counterMatch) {
      const name = decodeURIComponent(counterMatch[1]!);
      const action = counterMatch[3];
      const id = env.COUNTER.idFromName(name);
      const stub = env.COUNTER.get(id);

      if (!action && method === "GET") {
        const count = await stub.getCount();
        return Response.json({ name, count });
      }
      if (action === "increment" && method === "POST") {
        const count = await stub.increment();
        return Response.json({ name, count });
      }
      if (action === "decrement" && method === "POST") {
        const count = await stub.decrement();
        return Response.json({ name, count });
      }
      if (action === "reset" && method === "POST") {
        await stub.reset();
        return Response.json({ name, count: 0 });
      }
    }

    // ── Queue ──
    if (path === "/queue/send" && method === "POST") {
      const body = await request.json();
      await env.MY_QUEUE.send(body);
      return Response.json({ success: true }, { status: 201 });
    }
    if (path === "/queue/send-batch" && method === "POST") {
      const messages = (await request.json()) as { body: unknown }[];
      await env.MY_QUEUE.sendBatch(messages);
      return Response.json(
        { success: true, count: messages.length },
        { status: 201 },
      );
    }

    // ── Workflow ──
    if (path === "/workflow" && method === "POST") {
      const body = (await request.json()) as { input: string };
      const instance = await env.MY_WORKFLOW.create({
        params: { input: body.input },
      });
      return Response.json({ id: instance.id });
    }
    const wfMatch = path.match(/^\/workflow\/([^/]+)$/);
    if (wfMatch && method === "GET") {
      const instance = await env.MY_WORKFLOW.get(wfMatch[1]!);
      const status = await instance.status();
      return Response.json({ id: instance.id, status });
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      console.log(
        `[queue:${batch.queue}] Processing message ${msg.id}:`,
        msg.body,
      );
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env>;
