export { MyContainer } from './container'
export { Counter } from './counter'
export { ErrorBridge } from './error-bridge'
export { SqlNotes } from './notes'
export { Sandbox } from './sandbox'
export { MyWorkflow } from './workflow'

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
		{ headers: { 'Content-Type': 'text/html; charset=utf-8' } },
	)
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
    <a href="#" onclick="api('POST','/d1/seed');return false">Seed sample data</a>
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

<h2>SQL Notes (DO with SQLite)</h2>
<div class="section">
  <div class="links">
    <a href="#" onclick="api('GET','/notes/my-notebook');return false">LIST notes</a>
  </div>
  <form onsubmit="api('POST','/notes/'+formVal('notes-ns'),{title:formVal('note-title'),body:formVal('note-body')});return false">
    <label>Notebook <input id="notes-ns" value="my-notebook"></label>
    <label>Title <input id="note-title" value="Hello"></label>
    <label>Body <textarea id="note-body">First note using DO SQLite!</textarea></label>
    <button type="submit">Create note</button>
  </form>
  <form onsubmit="api('GET','/notes/'+formVal('notes-ns2')+'/'+formVal('note-get-id'));return false" style="margin-top:0.5rem">
    <label>Notebook <input id="notes-ns2" value="my-notebook"></label>
    <label>ID <input id="note-get-id" value="1" type="number"></label>
    <button type="submit" class="secondary">GET by ID</button>
  </form>
  <form onsubmit="api('DELETE','/notes/'+formVal('notes-ns3')+'/'+formVal('note-del-id'));return false" style="margin-top:0.5rem">
    <label>Notebook <input id="notes-ns3" value="my-notebook"></label>
    <label>ID <input id="note-del-id" value="1" type="number"></label>
    <button type="submit" class="danger">DELETE</button>
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

<h2>Echo Worker (Service Binding)</h2>
<div class="section">
  <div class="links">
    <a href="#" onclick="api('GET','/echo');return false">Ping echo worker</a>
    <a href="#" onclick="api('GET','/echo/info');return false">RPC: info()</a>
  </div>
  <form onsubmit="api('GET','/echo/greet?name='+encodeURIComponent(formVal('echo-name')));return false">
    <label>Name <input id="echo-name" value="Bunflare"></label>
    <button type="submit" class="secondary">RPC: greet(name)</button>
  </form>
  <form onsubmit="api('POST','/echo/fetch',formVal('echo-body'));return false" style="margin-top:0.5rem">
    <label>Body <input id="echo-body" value="hello from main worker"></label>
    <button type="submit">Fetch echo worker</button>
  </form>
</div>

<h2>Container</h2>
<div class="section">
  <div class="links">
    <a href="#" onclick="api('GET','/container/status');return false">GET status</a>
    <a href="#" onclick="api('POST','/container/start');return false">Start</a>
    <a href="#" onclick="api('POST','/container/stop');return false">Stop</a>
  </div>
  <form onsubmit="api('POST','/container/fetch',formVal('ctr-path'));return false">
    <label>Path <input id="ctr-path" value="/"></label>
    <button type="submit" class="secondary">Fetch container</button>
  </form>
</div>

<h2>Sandbox (Code Execution)</h2>
<div class="section">
  <p style="color:#888;font-size:0.85rem;margin-bottom:0.75rem">Runs commands in an isolated Docker container via @cloudflare/sandbox SDK.</p>
  <form onsubmit="api('POST','/sandbox/exec',{command:formVal('sb-cmd')});return false">
    <label>Command <input id="sb-cmd" value="node -e &quot;console.log('Hello from Sandbox!')&quot;" style="min-width:350px"></label>
    <button type="submit">Exec</button>
  </form>
  <form onsubmit="api('POST','/sandbox/write-and-run',{filename:formVal('sb-file'),code:formVal('sb-code')});return false" style="margin-top:0.5rem">
    <label>Filename <input id="sb-file" value="script.js"></label>
    <label>Code <textarea id="sb-code">const os = require('os');
console.log(\`Node \${process.version} on \${os.platform()} \${os.arch()}\`);
console.log(\`2 + 2 = \${2 + 2}\`);
const fib = n => n <= 1 ? n : fib(n-1) + fib(n-2);
for (let i = 0; i < 8; i++) console.log(\`  fib(\${i}) = \${fib(i)}\`);</textarea></label>
    <button type="submit">Write &amp; Run</button>
  </form>
  <div class="links" style="margin-top:0.5rem">
    <a href="#" onclick="api('POST','/sandbox/exec',{command:'uname -a'});return false">uname -a</a>
    <a href="#" onclick="api('POST','/sandbox/exec',{command:'ls -la /workspace'});return false">ls /workspace</a>
    <a href="#" onclick="api('POST','/sandbox/exec',{command:'node -e "console.log(JSON.stringify({node: process.version, arch: process.arch}))"'});return false">Node version</a>
  </div>
</div>

<h2>Analytics Engine</h2>
<div class="section">
  <div class="links">
    <a href="#" onclick="api('POST','/analytics/track',{index:'page-view',doubles:[1],blobs:['/home']});return false">Track page view</a>
    <a href="#" onclick="api('POST','/analytics/track',{index:'click',doubles:[Date.now()],blobs:['buy-button']});return false">Track click</a>
    <a href="#" onclick="api('POST','/analytics/track',{});return false">Track empty event</a>
  </div>
  <form onsubmit="api('POST','/analytics/track',{index:formVal('ae-idx'),doubles:formVal('ae-doubles')?JSON.parse('['+formVal('ae-doubles')+']'):[],blobs:formVal('ae-blobs')?formVal('ae-blobs').split(','):[]});return false">
    <label>Index <input id="ae-idx" value="custom-event"></label>
    <label>Doubles (comma-sep) <input id="ae-doubles" value="42,3.14"></label>
    <label>Blobs (comma-sep) <input id="ae-blobs" value="click,homepage"></label>
    <button type="submit">Write data point</button>
  </form>
</div>

<h2>Error Propagation (DO &rarr; service binding &rarr; worker)</h2>
<div class="section">
  <p style="color:#888;font-size:0.85rem;margin-bottom:0.75rem">ErrorBridge DO calls failing-worker through a service binding. Open links directly to see the error page.</p>
  <div class="links">
    <a href="/error-bridge/fetch/ok">fetch /ok (no error)</a>
    <a href="/error-bridge/fetch/throw">fetch /throw</a>
    <a href="/error-bridge/fetch/async-throw">fetch /async-throw</a>
    <a href="/error-bridge/fetch/deep-throw">fetch /deep-throw</a>
  </div>
  <div class="links" style="margin-top:0.5rem">
    <a href="/error-bridge/do-throw">DO throw (no service binding)</a>
    <a href="/error-bridge/rpc/ping">RPC ping (no error)</a>
    <a href="/error-bridge/rpc/syncExplode">RPC syncExplode</a>
    <a href="/error-bridge/rpc/asyncExplode">RPC asyncExplode</a>
    <a href="/error-bridge/rpc/deepExplode">RPC deepExplode</a>
  </div>
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
  `)
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		// ── Index ──
		if (path === '/' && method === 'GET') {
			return indexPage()
		}

		// ── KV ──
		if (path === '/kv' && method === 'GET') {
			const list = await env.KV.list()
			return Response.json(list)
		}
		const kvMatch = path.match(/^\/kv\/(.+)$/)
		if (kvMatch) {
			const key = decodeURIComponent(kvMatch[1]!)
			if (method === 'GET') {
				const value = await env.KV.get(key)
				if (value === null) return new Response('Not found', { status: 404 })
				return new Response(value)
			}
			if (method === 'PUT') {
				const body = await request.text()
				await env.KV.put(key, body)
				return new Response('OK', { status: 201 })
			}
			if (method === 'DELETE') {
				await env.KV.delete(key)
				return new Response('Deleted', { status: 200 })
			}
		}

		// ── R2 ──
		if (path === '/r2' && method === 'GET') {
			const list = await env.R2.list()
			return Response.json({
				objects: list.objects.map((o) => ({
					key: o.key,
					size: o.size,
					uploaded: o.uploaded,
				})),
				truncated: list.truncated,
			})
		}
		const r2Match = path.match(/^\/r2\/(.+)$/)
		if (r2Match) {
			const key = decodeURIComponent(r2Match[1]!)
			if (method === 'GET') {
				const object = await env.R2.get(key)
				if (!object) return new Response('Not found', { status: 404 })
				return new Response(object.body, {
					headers: {
						'Content-Type': object.httpMetadata?.contentType
							?? 'application/octet-stream',
						'ETag': object.etag,
					},
				})
			}
			if (method === 'PUT') {
				const body = await request.arrayBuffer()
				const ct = request.headers.get('content-type')
				await env.R2.put(key, body, {
					httpMetadata: ct ? { contentType: ct } : undefined,
				})
				return new Response('OK', { status: 201 })
			}
			if (method === 'DELETE') {
				await env.R2.delete(key)
				return new Response('Deleted', { status: 200 })
			}
		}

		// ── D1 ──
		if (path === '/d1/tables' && method === 'GET') {
			const result = await env.DB.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
			).all()
			return Response.json(result)
		}
		if (path === '/d1/query' && method === 'GET') {
			const sql = url.searchParams.get('sql')
			if (!sql) return new Response('Missing sql param', { status: 400 })
			const result = await env.DB.prepare(sql).all()
			return Response.json(result)
		}
		if (path === '/d1/query' && method === 'POST') {
			const body = (await request.json()) as { sql: string; params?: unknown[] }
			const stmt = body.params?.length
				? env.DB.prepare(body.sql).bind(...body.params)
				: env.DB.prepare(body.sql)
			const result = await stmt.all()
			return Response.json(result)
		}
		if (path === '/d1/exec' && method === 'POST') {
			const body = (await request.json()) as { sql: string }
			const result = await env.DB.exec(body.sql)
			return Response.json(result)
		}

		// ── D1 Seed ──
		if (path === '/d1/seed' && method === 'POST') {
			await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          sku TEXT NOT NULL UNIQUE,
          category_id INTEGER REFERENCES categories(id),
          price REAL NOT NULL,
          stock INTEGER NOT NULL DEFAULT 0,
          weight_kg REAL,
          is_active INTEGER NOT NULL DEFAULT 1,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          phone TEXT,
          city TEXT,
          country TEXT NOT NULL DEFAULT 'CZ',
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          status TEXT NOT NULL DEFAULT 'pending',
          total REAL NOT NULL DEFAULT 0,
          shipping_address TEXT,
          tracking_number TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          shipped_at TEXT
        );
        CREATE TABLE IF NOT EXISTS order_items (
          order_id INTEGER NOT NULL REFERENCES orders(id),
          product_id INTEGER NOT NULL REFERENCES products(id),
          quantity INTEGER NOT NULL,
          unit_price REAL NOT NULL,
          PRIMARY KEY (order_id, product_id)
        );
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS product_tags (
          product_id INTEGER NOT NULL REFERENCES products(id),
          tag_id INTEGER NOT NULL REFERENCES tags(id),
          PRIMARY KEY (product_id, tag_id)
        );

        DELETE FROM order_items;
        DELETE FROM orders;
        DELETE FROM product_tags;
        DELETE FROM products;
        DELETE FROM customers;
        DELETE FROM categories;
        DELETE FROM tags;

        INSERT INTO categories (name, slug, description, sort_order) VALUES
          ('Electronics', 'electronics', 'Gadgets and devices', 1),
          ('Books', 'books', 'Physical and digital books', 2),
          ('Clothing', 'clothing', NULL, 3),
          ('Home & Garden', 'home-garden', 'Furniture, decor, tools', 4),
          ('Food & Drink', 'food-drink', 'Gourmet items and beverages', 5);

        INSERT INTO products (name, sku, category_id, price, stock, weight_kg, is_active, description) VALUES
          ('Wireless Mouse', 'ELEC-001', 1, 29.99, 150, 0.12, 1, 'Ergonomic wireless mouse with USB-C receiver'),
          ('Mechanical Keyboard', 'ELEC-002', 1, 89.50, 42, 0.85, 1, 'Cherry MX Brown switches, TKL layout'),
          ('USB-C Hub', 'ELEC-003', 1, 45.00, 0, 0.15, 0, 'Out of stock — 7-port hub'),
          ('27" Monitor', 'ELEC-004', 1, 349.99, 18, 5.2, 1, NULL),
          ('Clean Code', 'BOOK-001', 2, 35.90, 200, 0.65, 1, 'Robert C. Martin — A Handbook of Agile Software Craftsmanship'),
          ('DDIA', 'BOOK-002', 2, 42.00, 85, 0.9, 1, 'Designing Data-Intensive Applications by Martin Kleppmann'),
          ('The Pragmatic Programmer', 'BOOK-003', 2, 39.99, 120, 0.7, 1, NULL),
          ('TypeScript Handbook', 'BOOK-004', 2, 0, 999, NULL, 1, 'Free digital download'),
          ('Cotton T-Shirt', 'CLTH-001', 3, 19.99, 500, 0.2, 1, '100% organic cotton, unisex'),
          ('Winter Jacket', 'CLTH-002', 3, 129.00, 35, 1.1, 1, 'Water-resistant, -20°C rated'),
          ('Standing Desk', 'HOME-001', 4, 599.00, 8, 32.0, 1, 'Electric height-adjustable, 160x80cm'),
          ('Desk Lamp', 'HOME-002', 4, 34.50, 67, 1.2, 1, 'LED, adjustable color temperature'),
          ('Espresso Beans 1kg', 'FOOD-001', 5, 18.90, 300, 1.0, 1, 'Single-origin Ethiopian Yirgacheffe'),
          ('Matcha Powder', 'FOOD-002', 5, 24.50, 0, 0.1, 0, NULL);

        INSERT INTO tags (label) VALUES ('bestseller'), ('new'), ('sale'), ('eco-friendly'), ('premium');

        INSERT INTO product_tags (product_id, tag_id) VALUES
          (1, 1), (1, 4),
          (2, 2), (2, 5),
          (5, 1),
          (6, 1), (6, 5),
          (9, 4),
          (11, 2), (11, 5),
          (13, 1), (13, 4);

        INSERT INTO customers (email, first_name, last_name, phone, city, country, note) VALUES
          ('alice@example.com', 'Alice', 'Nováková', '+420601111111', 'Praha', 'CZ', NULL),
          ('bob@example.com', 'Bob', 'Dvořák', '+420602222222', 'Brno', 'CZ', 'VIP customer'),
          ('charlie@example.com', 'Charlie', 'Smith', NULL, 'London', 'GB', NULL),
          ('diana@example.com', 'Diana', 'Müller', '+491701234567', 'Berlin', 'DE', 'Prefers DHL shipping'),
          ('eva@example.com', 'Eva', 'Svobodová', '+420605555555', 'Ostrava', 'CZ', NULL),
          ('frank@example.com', 'Frank', 'Kovář', NULL, NULL, 'CZ', 'Wholesale buyer'),
          ('grace@example.com', 'Grace', 'Hopper', '+1-555-0100', 'New York', 'US', NULL),
          ('hana@example.com', 'Hana', 'Procházková', '+420608888888', 'Plzeň', 'CZ', NULL);

        INSERT INTO orders (customer_id, status, total, shipping_address, tracking_number, shipped_at) VALUES
          (1, 'delivered', 119.49, 'Vinohradská 12, Praha 2', 'CZ12345678', '2025-12-01 10:00:00'),
          (1, 'shipped', 349.99, 'Vinohradská 12, Praha 2', 'CZ23456789', '2026-01-15 14:30:00'),
          (2, 'pending', 89.50, 'Masarykova 5, Brno', NULL, NULL),
          (3, 'delivered', 75.89, '42 Baker St, London', 'GB98765432', '2025-11-20 09:00:00'),
          (4, 'processing', 633.50, 'Friedrichstr. 100, Berlin', NULL, NULL),
          (5, 'pending', 19.99, 'Stodolní 7, Ostrava', NULL, NULL),
          (6, 'cancelled', 599.00, NULL, NULL, NULL),
          (7, 'delivered', 77.90, '123 Broadway, New York', 'US11223344', '2025-10-05 16:00:00'),
          (2, 'delivered', 42.00, 'Masarykova 5, Brno', 'CZ34567890', '2026-02-01 11:00:00'),
          (8, 'shipped', 164.49, 'Americká 42, Plzeň', 'CZ45678901', '2026-02-10 08:00:00');

        INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
          (1, 1, 1, 29.99),
          (1, 2, 1, 89.50),
          (2, 4, 1, 349.99),
          (3, 2, 1, 89.50),
          (4, 5, 1, 35.90),
          (4, 9, 2, 19.99),
          (5, 11, 1, 599.00),
          (5, 12, 1, 34.50),
          (6, 9, 1, 19.99),
          (7, 11, 1, 599.00),
          (8, 5, 1, 35.90),
          (8, 6, 1, 42.00),
          (9, 6, 1, 42.00),
          (10, 10, 1, 129.00),
          (10, 5, 1, 35.49);
      `)
			return Response.json({ ok: true, message: 'Seeded 7 tables with sample data' })
		}

		// ── Counter DO ──
		const counterMatch = path.match(/^\/counter\/([^/]+)(\/(.+))?$/)
		if (counterMatch) {
			const name = decodeURIComponent(counterMatch[1]!)
			const action = counterMatch[3]
			const id = env.COUNTER.idFromName(name)
			const stub = env.COUNTER.get(id)

			if (!action && method === 'GET') {
				const count = await stub.getCount()
				return Response.json({ name, count })
			}
			if (action === 'increment' && method === 'POST') {
				const count = await stub.increment()
				return Response.json({ name, count })
			}
			if (action === 'decrement' && method === 'POST') {
				const count = await stub.decrement()
				return Response.json({ name, count })
			}
			if (action === 'reset' && method === 'POST') {
				await stub.reset()
				return Response.json({ name, count: 0 })
			}
		}

		// ── Container ──
		if (path.startsWith('/container')) {
			const id = env.MY_CONTAINER.idFromName('singleton')
			const stub = env.MY_CONTAINER.get(id)

			if (path === '/container/status' && method === 'GET') {
				const state = await stub.getState()
				return Response.json(state)
			}
			if (path === '/container/start' && method === 'POST') {
				stub.start()
				return Response.json({ success: true })
			}
			if (path === '/container/stop' && method === 'POST') {
				await stub.stop()
				return Response.json({ success: true })
			}
			if (path === '/container/fetch' && method === 'POST') {
				const targetPath = await request.text() || '/'
				const res = await stub.fetch(new Request(`http://container${targetPath}`))
				return new Response(await res.text(), {
					status: res.status,
					headers: res.headers,
				})
			}
		}

		// ── SQL Notes DO ──
		const notesMatch = path.match(/^\/notes\/([^/]+)(\/(\d+))?$/)
		if (notesMatch) {
			const name = decodeURIComponent(notesMatch[1]!)
			const noteId = notesMatch[3] ? parseInt(notesMatch[3]) : null
			const id = env.SQL_NOTES.idFromName(name)
			const stub = env.SQL_NOTES.get(id)

			if (!noteId && method === 'GET') {
				const notes = await stub.list()
				return Response.json({ notebook: name, notes })
			}
			if (!noteId && method === 'POST') {
				const body = (await request.json()) as { title: string; body?: string }
				const note = await stub.create(body.title, body.body ?? '')
				return Response.json(note, { status: 201 })
			}
			if (noteId && method === 'GET') {
				const note = await stub.get(noteId)
				return Response.json(note)
			}
			if (noteId && method === 'DELETE') {
				await stub.remove(noteId)
				return Response.json({ deleted: noteId })
			}
		}

		// ── Analytics Engine ──
		if (path === '/analytics/track' && method === 'POST') {
			const body = (await request.json()) as { index?: string; doubles?: number[]; blobs?: string[] }
			env.ANALYTICS.writeDataPoint({
				indexes: body.index ? [body.index] : undefined,
				doubles: body.doubles,
				blobs: body.blobs,
			})
			return Response.json({ success: true }, { status: 201 })
		}

		// ── Queue ──
		if (path === '/queue/send' && method === 'POST') {
			const body = await request.json()
			await env.MY_QUEUE.send(body)
			return Response.json({ success: true }, { status: 201 })
		}
		if (path === '/queue/send-batch' && method === 'POST') {
			const messages = (await request.json()) as { body: unknown }[]
			await env.MY_QUEUE.sendBatch(messages)
			return Response.json(
				{ success: true, count: messages.length },
				{ status: 201 },
			)
		}

		// ── Workflow ──
		if (path === '/workflow' && method === 'POST') {
			const body = (await request.json()) as { input: string }
			const instance = await env.MY_WORKFLOW.create({
				params: { input: body.input },
			})
			return Response.json({ id: instance.id })
		}
		const wfMatch = path.match(/^\/workflow\/([^/]+)$/)
		if (wfMatch && method === 'GET') {
			const instance = await env.MY_WORKFLOW.get(wfMatch[1]!)
			const status = await instance.status()
			return Response.json({ id: instance.id, status })
		}

		// ── Sandbox ──
		if (path === '/sandbox/exec' && method === 'POST') {
			const { getSandbox } = await import('@cloudflare/sandbox')
			const sandbox = getSandbox(env.SANDBOX, 'dev')
			const body = (await request.json()) as { command: string }
			const result = await sandbox.exec(body.command)
			return Response.json({
				success: result.success,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				command: result.command,
				duration: result.duration,
			})
		}
		if (path === '/sandbox/write-and-run' && method === 'POST') {
			const { getSandbox } = await import('@cloudflare/sandbox')
			const sandbox = getSandbox(env.SANDBOX, 'dev')
			const body = (await request.json()) as { filename: string; code: string }
			await sandbox.writeFile(`/workspace/${body.filename}`, body.code)
			const ext = body.filename.split('.').pop()
			const runner = ext === 'py' ? 'python3' : ext === 'js' ? 'node' : ext === 'ts' ? 'npx tsx' : 'bash'
			const result = await sandbox.exec(`${runner} /workspace/${body.filename}`)
			return Response.json({
				success: result.success,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				command: result.command,
				duration: result.duration,
			})
		}

		// ── Error Bridge DO → service binding → failing-worker ──
		const ebFetchMatch = path.match(/^\/error-bridge\/fetch\/(.+)$/)
		if (ebFetchMatch && method === 'GET') {
			const id = env.ERROR_BRIDGE.idFromName('singleton')
			const stub = env.ERROR_BRIDGE.get(id)
			const text = await stub.callFetch('/' + ebFetchMatch[1]!)
			return new Response(text)
		}
		const ebRpcMatch = path.match(/^\/error-bridge\/rpc\/(.+)$/)
		if (ebRpcMatch && method === 'GET') {
			const id = env.ERROR_BRIDGE.idFromName('singleton')
			const stub = env.ERROR_BRIDGE.get(id)
			const result = await stub.callRpc(ebRpcMatch[1]!)
			return Response.json({ result })
		}
		if (path === '/error-bridge/do-throw' && method === 'GET') {
			const id = env.ERROR_BRIDGE.idFromName('singleton')
			const stub = env.ERROR_BRIDGE.get(id)
			await stub.doThrow()
			return new Response('unreachable')
		}

		// ── Echo service binding ──
		if (path === '/echo' && method === 'GET') {
			const res = await env.ECHO.fetch(new Request('http://echo/ping'))
			return new Response(await res.text())
		}
		if (path === '/echo/fetch' && method === 'POST') {
			const res = await env.ECHO.fetch(new Request('http://echo/echo', { method: 'POST', body: await request.text() }))
			return res
		}
		if (path === '/echo/greet' && method === 'GET') {
			const name = url.searchParams.get('name') ?? 'world'
			const greeting = await (env.ECHO as any).greet(name)
			return Response.json({ greeting })
		}
		if (path === '/echo/info' && method === 'GET') {
			const info = await (env.ECHO as any).info()
			return Response.json(info)
		}

		return new Response('Not found', { status: 404 })
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[scheduled] Cron fired: ${controller.cron} at ${new Date(controller.scheduledTime).toISOString()}`)
	},

	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[email] Received from: ${message.from}, to: ${message.to}, size: ${message.rawSize}`)
		const subject = message.headers.get('subject') ?? '(no subject)'
		console.log(`[email] Subject: ${subject}`)

		// Example: forward emails addressed to forward@
		if (message.to.startsWith('forward@')) {
			await message.forward('admin@example.com')
			console.log('[email] Forwarded to admin@example.com')
			return
		}

		// Example: reject emails addressed to reject@
		if (message.to.startsWith('reject@')) {
			message.setReject('Address not accepted')
			console.log('[email] Rejected')
			return
		}

		// Example: send a reply using the MAILER binding
		const { EmailMessage } = await import('cloudflare:email')
		const replyRaw = `From: ${message.to}\r\nTo: ${message.from}\r\nSubject: Re: ${subject}\r\n\r\nThanks for your email!`
		const reply = new EmailMessage(message.to, message.from, replyRaw)
		await env.MAILER.send(reply)
		console.log('[email] Auto-reply sent')
	},

	async queue(batch: MessageBatch, env: Env): Promise<void> {
		for (const msg of batch.messages) {
			console.log(
				`[queue:${batch.queue}] Processing message ${msg.id}:`,
				msg.body,
			)
			msg.ack()
		}
	},
} satisfies ExportedHandler<Env>
