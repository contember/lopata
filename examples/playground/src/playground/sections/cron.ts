import { registerSection } from '../registry'

// Keep in sync with wrangler.jsonc → triggers.crons.
const CONFIGURED_CRONS = ['*/5 * * * *']

registerSection({
	slug: 'cron',
	title: 'Scheduled — Cron Triggers',
	html: `
  <p class="note">
    Manually fire any configured cron via lopata's <code>/cdn-cgi/handler/scheduled</code> endpoint.
    History is stored in localStorage and only reflects manual fires triggered here —
    real timer-driven fires log to console (see <a href="/__dashboard/traces" target="_blank">Traces ↗</a>).
  </p>
  <div id="cron-list" style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1rem"></div>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-top:1rem;gap:0.5rem">
    <strong style="color:#fb923c;font-size:0.9rem">Recent fires</strong>
    <button class="danger" type="button" onclick="cronClearHistory()">Clear history</button>
  </div>
  <div id="cron-history" style="margin-top:0.5rem;font-family:monospace;font-size:0.82rem;color:#cfcfcf"></div>
  <script>
    (function () {
      var CRONS = ${JSON.stringify(CONFIGURED_CRONS)};
      var HISTORY_KEY = 'lopata-playground-cron-history';
      var LAST_KEY = 'lopata-playground-cron-last';
      var MAX_HISTORY = 100;

      function loadJSON(key, fallback) {
        try {
          var raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch (_) { return fallback; }
      }
      function saveJSON(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
      }

      function fmtTime(ts) {
        var d = new Date(ts);
        return d.toLocaleTimeString() + ' · ' + d.toLocaleDateString();
      }

      function renderConfigured() {
        var lastMap = loadJSON(LAST_KEY, {});
        var container = document.getElementById('cron-list');
        if (!container) return;
        container.innerHTML = '';
        CRONS.forEach(function (cron) {
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0.75rem;background:#181818;border:1px solid #2a2a2a;border-radius:6px';
          var expr = document.createElement('code');
          expr.style.cssText = 'color:#fb923c;font-weight:600;min-width:8rem';
          expr.textContent = cron;
          var last = document.createElement('span');
          last.style.cssText = 'color:#888;font-size:0.82rem;flex:1';
          last.textContent = lastMap[cron] ? 'Last fired: ' + fmtTime(lastMap[cron]) : 'Never fired (via UI)';
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = 'Fire now';
          btn.addEventListener('click', function () { fireCron(cron, btn); });
          row.appendChild(expr);
          row.appendChild(last);
          row.appendChild(btn);
          container.appendChild(row);
        });
      }

      function renderHistory() {
        var history = loadJSON(HISTORY_KEY, []);
        var container = document.getElementById('cron-history');
        if (!container) return;
        if (history.length === 0) {
          container.innerHTML = '<div style="color:#666;padding:0.5rem 0">No manual fires yet.</div>';
          return;
        }
        container.innerHTML = '';
        history.forEach(function (entry) {
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:0.75rem;align-items:center;padding:0.35rem 0.5rem;border-bottom:1px solid #1f1f1f';
          var status = document.createElement('span');
          var ok = entry.ok;
          status.style.cssText = 'font-size:0.72rem;padding:0.1rem 0.4rem;border-radius:3px;' +
            (ok ? 'background:#166534;color:#4ade80' : 'background:#7f1d1d;color:#fca5a5');
          status.textContent = ok ? 'OK' : 'ERR';
          var ts = document.createElement('span');
          ts.style.cssText = 'color:#888;min-width:11rem';
          ts.textContent = fmtTime(entry.ts);
          var expr = document.createElement('code');
          expr.style.cssText = 'color:#cfcfcf;flex:1';
          expr.textContent = entry.cron;
          var dur = document.createElement('span');
          dur.style.cssText = 'color:#777;font-size:0.78rem';
          dur.textContent = (entry.duration / 1000).toFixed(2) + 's';
          row.appendChild(status);
          row.appendChild(ts);
          row.appendChild(expr);
          row.appendChild(dur);
          if (!ok && entry.error) {
            var err = document.createElement('span');
            err.style.cssText = 'color:#fca5a5;font-size:0.78rem;max-width:18rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
            err.title = entry.error;
            err.textContent = entry.error;
            row.appendChild(err);
          }
          container.appendChild(row);
        });
      }

      async function fireCron(cron, btn) {
        btn.disabled = true;
        var originalLabel = btn.textContent;
        btn.textContent = 'Firing…';
        var start = performance.now();
        var ok = false;
        var error = null;
        try {
          var res = await fetch('/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent(cron), { method: 'GET' });
          ok = res.ok;
          if (!ok) error = (await res.text()) || ('HTTP ' + res.status);
        } catch (e) {
          ok = false;
          error = (e && e.message) ? e.message : String(e);
        }
        var duration = performance.now() - start;
        btn.disabled = false;
        btn.textContent = originalLabel;

        var ts = Date.now();
        var history = loadJSON(HISTORY_KEY, []);
        history.unshift({ ts: ts, cron: cron, ok: ok, duration: duration, error: error });
        if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
        saveJSON(HISTORY_KEY, history);

        var lastMap = loadJSON(LAST_KEY, {});
        lastMap[cron] = ts;
        saveJSON(LAST_KEY, lastMap);

        renderConfigured();
        renderHistory();
      }

      window.cronClearHistory = function () {
        saveJSON(HISTORY_KEY, []);
        saveJSON(LAST_KEY, {});
        renderConfigured();
        renderHistory();
      };

      function init() {
        renderConfigured();
        renderHistory();
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    })();
  </script>
  `,
	handle() {
		return null
	},
})
