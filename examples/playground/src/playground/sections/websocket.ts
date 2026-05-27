import { registerSection } from '../registry'

registerSection({
	slug: 'websocket',
	title: 'WebSocket',
	html: `
  <p class="note">
    <code>/ws/echo</code> exercises the plain-worker WS bridge; <code>/ws/counter/&lt;name&gt;</code> opens a WS through the Counter DO and broadcasts on every increment/decrement.
  </p>
  <div>
    <label>Counter name <input id="ws-name" value="alice"></label>
    <button onclick="wsConnect()">Connect</button>
    <button onclick="wsSend('inc')" class="secondary">+1</button>
    <button onclick="wsSend('dec')" class="secondary">-1</button>
    <button onclick="wsSend('reset')" class="secondary">reset</button>
    <button onclick="wsClose()" class="secondary">Disconnect</button>
  </div>
  <div style="margin-top:0.5rem">
    <label>Echo message <input id="ws-echo" value="hello"></label>
    <button onclick="wsEcho()">Send /ws/echo</button>
  </div>
  <pre id="ws-log" style="margin-top:0.75rem; background:#111; border:1px solid #333; border-radius:6px; padding:0.6rem; max-height:14rem; overflow:auto; font-family:monospace; font-size:0.82rem; color:#cfcfcf"></pre>
  <script>
  var wsCounter = null;
  function wsLog(msg) {
    var el = document.getElementById('ws-log');
    el.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg + '\\n' + el.textContent;
  }
  function wsConnect() {
    wsClose();
    var name = encodeURIComponent(formVal('ws-name') || 'alice');
    wsCounter = new WebSocket('ws://' + location.host + '/ws/counter/' + name);
    wsCounter.onopen = function () { wsLog('counter open'); };
    wsCounter.onmessage = function (ev) { wsLog('counter: ' + ev.data); };
    wsCounter.onclose = function (ev) { wsLog('counter closed (' + ev.code + ')'); };
  }
  function wsSend(cmd) {
    if (wsCounter && wsCounter.readyState === 1) wsCounter.send(cmd);
  }
  function wsClose() {
    if (wsCounter) wsCounter.close();
    wsCounter = null;
  }
  function wsEcho() {
    var ws = new WebSocket('ws://' + location.host + '/ws/echo');
    ws.onopen = function () { ws.send(formVal('ws-echo') || 'hello'); };
    ws.onmessage = function (ev) { wsLog('echo: ' + ev.data); ws.close(); };
  }
  </script>
  `,
	handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname

		if (path === '/ws/echo') {
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected websocket', { status: 426 })
			}
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.accept()
			server.addEventListener('message', (event: MessageEvent) => {
				const data = event.data
				server.send(typeof data === 'string' ? `echo:${data}` : data)
			})
			return new Response(null, { status: 101, webSocket: client } as any)
		}

		const counterWsMatch = path.match(/^\/ws\/counter\/([^/]+)$/)
		if (counterWsMatch) {
			const name = decodeURIComponent(counterWsMatch[1]!)
			const stub = env.COUNTER.get(env.COUNTER.idFromName(name))
			return stub.fetch(request)
		}
		return null
	},
})
