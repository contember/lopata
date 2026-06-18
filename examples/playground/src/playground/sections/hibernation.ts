import { registerSection } from '../registry'

registerSection({
	slug: 'hibernation',
	title: 'Durable Object — Hibernating Chat',
	html: `
  <p class="note">
    Uses the hibernation API: <code>state.acceptWebSocket(server, [name])</code> + <code>webSocketMessage(ws, msg)</code> on the DO class.
    The DO can be evicted between messages; the WS stays open and resumes when the next message arrives.
    Lopata's recent <code>_wsCount</code> fix keeps the connection counter accurate across executor evictions.
  </p>
  <p class="note">
    On reload (you save a file, lopata restarts the worker, or you hit "Reload page"),
    open WebSockets receive a <code>1012 Service Restart</code> close. Just reconnect to continue.
  </p>
  <div>
    <label>Name <input id="hc-name" value="alice"></label>
    <button onclick="hcJoin()">Join</button>
    <button onclick="hcClose()" class="secondary">Leave</button>
    <button onclick="hcBacklog()" class="secondary">Show backlog (RPC)</button>
  </div>
  <div style="margin-top:0.5rem">
    <label>Message <input id="hc-msg" value="hello"></label>
    <button onclick="hcSend()">Send</button>
  </div>
  <pre id="hc-log" style="margin-top:0.75rem; background:#111; border:1px solid #333; border-radius:6px; padding:0.6rem; max-height:14rem; overflow:auto; font-family:monospace; font-size:0.82rem; color:#cfcfcf"></pre>
  <script>
  var hcWs = null;
  function hcLog(line) {
    var el = document.getElementById('hc-log');
    el.textContent = '[' + new Date().toLocaleTimeString() + '] ' + line + '\\n' + el.textContent;
  }
  function hcJoin() {
    hcClose();
    var name = encodeURIComponent(formVal('hc-name') || 'anon');
    hcWs = new WebSocket('ws://' + location.host + '/hibernating-chat/' + name);
    hcWs.onopen = function () { hcLog('open as ' + decodeURIComponent(name)); };
    hcWs.onmessage = function (ev) {
      try {
        var d = JSON.parse(ev.data);
        if (d.type === 'hello') {
          hcLog('hello (you=' + d.you + ', backlog=' + (d.backlog || []).length + ')');
          (d.backlog || []).forEach(function (m) { hcLog('backlog: ' + m.from + ': ' + m.text); });
        } else if (d.type === 'msg') {
          hcLog(d.from + ': ' + d.text);
        } else {
          hcLog('recv: ' + ev.data);
        }
      } catch (e) { hcLog('recv: ' + ev.data); }
    };
    hcWs.onclose = function (ev) {
      hcLog('closed (' + ev.code + (ev.reason ? ' ' + ev.reason : '') + ')');
    };
    hcWs.onerror = function () { hcLog('error'); };
  }
  function hcSend() {
    if (!hcWs || hcWs.readyState !== 1) { hcLog('not connected'); return; }
    var text = formVal('hc-msg') || '';
    hcWs.send(JSON.stringify({ type: 'msg', text: text }));
  }
  function hcClose() {
    if (hcWs) hcWs.close();
    hcWs = null;
  }
  function hcBacklog() {
    var name = encodeURIComponent(formVal('hc-name') || 'anon');
    api('GET', '/hibernating-chat/' + name + '/backlog');
  }
  </script>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const match = path.match(/^\/hibernating-chat\/([^/]+)(\/(.+))?$/)
		if (!match) return null

		const name = decodeURIComponent(match[1]!)
		const action = match[3]
		const id = env.HIBERNATING_CHAT.idFromName(name)
		const stub = env.HIBERNATING_CHAT.get(id)

		if (!action && request.headers.get('Upgrade') === 'websocket') {
			return stub.fetch(request)
		}

		if (action === 'backlog' && request.method === 'GET') {
			const backlog = await stub.getBacklog()
			return Response.json({ name, backlog })
		}

		return null
	},
})
