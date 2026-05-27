import { registerSection } from '../registry'

registerSection({
	slug: 'streaming',
	title: 'Streaming',
	html: `
  <p class="note">
    Exercises end-to-end body streaming across the worker-thread boundary.
    Server-Sent Events test response streaming; the chunked upload echo tests
    request <em>and</em> response streaming.
  </p>

  <h4 style="color:#fb923c;margin:0.5rem 0 0.4rem">Server-Sent Events</h4>
  <div class="links">
    <button onclick="sseStart()">Start SSE stream</button>
    <button onclick="sseCancel()" class="danger">Cancel mid-stream</button>
  </div>
  <canvas id="sse-canvas" width="640" height="160" style="width:100%;max-width:640px;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:6px;display:block"></canvas>
  <pre id="sse-log" style="margin-top:0.5rem;background:#111;border:1px solid #333;border-radius:6px;padding:0.5rem;max-height:10rem;overflow:auto;font-family:monospace;font-size:0.8rem;color:#cfcfcf"></pre>

  <h4 style="color:#fb923c;margin:1.25rem 0 0.4rem">Chunked upload echo</h4>
  <p class="note">
    The client splits the payload into N pieces, releases them at the chosen
    interval, and reads the streamed echo into the response card. Try a high
    chunk count with a long delay — you should see entries appear one by one.
  </p>
  <form onsubmit="uploadEcho();return false">
    <label style="flex:1;min-width:240px">
      Payload
      <textarea id="up-payload">The quick brown fox jumps over the lazy dog. Streaming chunks should appear one at a time in the response card on the right.</textarea>
    </label>
    <label>Chunks <input id="up-chunks" type="number" min="1" max="64" value="8" style="width:5rem"></label>
    <label>Delay (ms) <input id="up-delay" type="number" min="0" max="2000" value="50" style="width:6rem"></label>
    <button type="submit">Send</button>
  </form>
  <p id="up-mode" class="note" style="margin-top:0.4rem"></p>

  <script>
  var sseAbort = null;
  function sseLog(msg) {
    var el = document.getElementById('sse-log');
    el.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg + '\\n' + el.textContent;
  }

  function sseCanvasReset() {
    var c = document.getElementById('sse-canvas');
    var g = c.getContext('2d');
    g.fillStyle = '#0d0d0d';
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#222';
    g.beginPath();
    g.moveTo(0, c.height / 2);
    g.lineTo(c.width, c.height / 2);
    g.stroke();
  }

  function sseCanvasPoint(i, total, sin) {
    var c = document.getElementById('sse-canvas');
    var g = c.getContext('2d');
    var x = (i / (total - 1)) * (c.width - 10) + 5;
    var y = c.height / 2 - sin * (c.height / 2 - 10);
    g.fillStyle = '#f97316';
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
  }

  async function sseStart() {
    sseCancel();
    sseCanvasReset();
    sseLog('starting…');
    var ctrl = new AbortController();
    sseAbort = ctrl;
    try {
      var res = await fetch('/stream/sse', { signal: ctrl.signal });
      if (!res.ok || !res.body) { sseLog('bad response ' + res.status); return; }
      var reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      var buf = '';
      var total = 20;
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        buf += r.value;
        var idx;
        while ((idx = buf.indexOf('\\n\\n')) !== -1) {
          var frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          var line = frame.split('\\n').find(function (l) { return l.indexOf('data:') === 0; });
          if (!line) continue;
          try {
            var data = JSON.parse(line.slice(5).trim());
            sseLog('tick ' + data.n + ' sin=' + data.sin.toFixed(3));
            sseCanvasPoint(data.n, total, data.sin);
          } catch (e) { sseLog('parse error: ' + e.message); }
        }
      }
      sseLog('✓ stream completed (20 ticks)');
    } catch (e) {
      if (e && e.name === 'AbortError') sseLog('aborted by client');
      else sseLog('error: ' + (e && e.message ? e.message : e));
    } finally {
      if (sseAbort === ctrl) sseAbort = null;
    }
  }

  function sseCancel() {
    if (sseAbort) {
      sseAbort.abort();
      sseAbort = null;
    }
  }

  function uploadMode(mode) {
    var el = document.getElementById('up-mode');
    el.textContent = mode === 'stream'
      ? 'using ReadableStream request body (duplex: half) — request streaming live'
      : 'browser does not support duplex request streams — fell back to Blob body';
  }

  async function uploadEcho() {
    var payload = document.getElementById('up-payload').value || '';
    var n = Math.max(1, parseInt(document.getElementById('up-chunks').value, 10) || 1);
    var delay = Math.max(0, parseInt(document.getElementById('up-delay').value, 10) || 0);
    if (!payload.length) payload = ' ';
    var size = Math.ceil(payload.length / n);
    var chunks = [];
    for (var i = 0; i < n; i++) chunks.push(payload.slice(i * size, (i + 1) * size));
    var enc = new TextEncoder();

    var streamBody = new ReadableStream({
      async start(controller) {
        for (var i = 0; i < chunks.length; i++) {
          controller.enqueue(enc.encode(chunks[i]));
          if (delay > 0 && i < chunks.length - 1) {
            await new Promise(function (r) { setTimeout(r, delay); });
          }
        }
        controller.close();
      },
    });

    var tryStream = true;
    try {
      var probe = new Request('about:blank', { method: 'POST', body: 'x', duplex: 'half' });
      void probe;
    } catch (e) { tryStream = false; }

    if (tryStream) {
      try {
        uploadMode('stream');
        var card = pushHistoryCard('POST', '/stream/upload-echo');
        var start = performance.now();
        var res = await fetch('/stream/upload-echo', {
          method: 'POST',
          body: streamBody,
          duplex: 'half',
          headers: { 'Content-Type': 'text/plain' },
        });
        card.setStatus(res.status, res.statusText || '', res.ok);
        card.set('');
        if (res.body) {
          var reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          while (true) {
            var r = await reader.read();
            if (r.done) break;
            card.append(r.value);
          }
        }
        card.setDuration(performance.now() - start);
        return;
      } catch (e) {
        if (e && /duplex/i.test(String(e && e.message))) {
          tryStream = false;
        } else {
          throw e;
        }
      }
    }

    uploadMode('blob');
    var collected = [];
    var reader = streamBody.getReader();
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      collected.push(r.value);
    }
    var blob = new Blob(collected, { type: 'text/plain' });
    await api('POST', '/stream/upload-echo', blob);
  }
  </script>
  `,
	async handle(request, _env, _ctx) {
		const url = new URL(request.url)

		if (url.pathname === '/stream/sse' && request.method === 'GET') {
			const total = 20
			const stream = new ReadableStream({
				start(controller) {
					let i = 0
					let timer: ReturnType<typeof setInterval> | null = null
					const enc = new TextEncoder()
					const tick = () => {
						if (i >= total) {
							if (timer) {
								clearInterval(timer)
								timer = null
							}
							try {
								controller.close()
							} catch {}
							return
						}
						const payload = { n: i, ts: new Date().toISOString(), sin: Math.sin(i / 3) }
						try {
							controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
						} catch {
							if (timer) {
								clearInterval(timer)
								timer = null
							}
							return
						}
						i++
					}
					timer = setInterval(tick, 250)
					tick()
					;(this as unknown as { _stopTimer?: () => void; _lastTick?: () => number })._stopTimer = () => {
						if (timer) {
							clearInterval(timer)
							timer = null
						}
					}
					;(this as unknown as { _lastTick: () => number })._lastTick = () => i
				},
				cancel() {
					const self = this as unknown as { _stopTimer?: () => void; _lastTick?: () => number }
					const at = self._lastTick ? self._lastTick() : -1
					self._stopTimer?.()
					console.log(`[sse] cancelled at tick ${at}`)
				},
			})
			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'X-Accel-Buffering': 'no',
				},
			})
		}

		if (url.pathname === '/stream/upload-echo' && request.method === 'POST') {
			if (!request.body) {
				return new Response('Expected request body', { status: 400 })
			}
			const reader = request.body.getReader()
			const enc = new TextEncoder()
			const dec = new TextDecoder()
			const stream = new ReadableStream({
				async pull(controller) {
					try {
						const { value, done } = await reader.read()
						if (done) {
							controller.close()
							return
						}
						const text = dec.decode(value, { stream: true })
						controller.enqueue(enc.encode(`[${value.byteLength}B] ${text}\n`))
					} catch (e) {
						controller.error(e)
					}
				},
				cancel(reason) {
					reader.cancel(reason).catch(() => {})
				},
			})
			return new Response(stream, {
				headers: {
					'Content-Type': 'text/plain; charset=utf-8',
					'Transfer-Encoding': 'chunked',
					'X-Accel-Buffering': 'no',
				},
			})
		}

		return null
	},
})
