import type { Section } from './registry'

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a; color: #e0e0e0; }
  body { font-family: system-ui, sans-serif; min-height: 100vh; }

  header.top {
    position: sticky; top: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.75rem 1.25rem; background: rgba(10,10,10,0.95);
    border-bottom: 1px solid #2a2a2a; backdrop-filter: blur(6px);
  }
  header.top h1 { font-size: 1.1rem; color: #f97316; letter-spacing: 0.02em; }
  header.top .top-actions { display: flex; gap: 0.5rem; align-items: center; }
  header.top a.btn-link {
    background: #f97316; color: #000; text-decoration: none;
    padding: 0.35rem 0.8rem; border-radius: 4px; font-weight: 600; font-size: 0.85rem;
  }
  header.top a.btn-link:hover { background: #fb923c; }
  header.top a.trace-link {
    background: #222; color: #ddd; text-decoration: none;
    padding: 0.35rem 0.7rem; border-radius: 4px; font-size: 0.8rem; border: 1px solid #333;
  }
  header.top a.trace-link:hover { background: #2a2a2a; }

  .layout { display: grid; grid-template-columns: 220px 1fr; gap: 1.5rem; padding: 1.25rem; max-width: 1280px; margin: 0 auto; }

  aside.sidebar {
    position: sticky; top: 4rem; align-self: start;
    max-height: calc(100vh - 5rem); overflow-y: auto;
    border: 1px solid #1f1f1f; border-radius: 8px; padding: 0.75rem; background: #0e0e0e;
  }
  aside.sidebar h3 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 0.5rem; }
  aside.sidebar ul { list-style: none; }
  aside.sidebar li a {
    display: block; padding: 0.35rem 0.5rem; border-radius: 4px;
    color: #bbb; text-decoration: none; font-size: 0.88rem;
    border-left: 2px solid transparent;
  }
  aside.sidebar li a:hover { background: #1a1a1a; color: #fff; }
  aside.sidebar li a.active { background: #1f1410; color: #fb923c; border-left-color: #f97316; }

  main { min-width: 0; }
  .subtitle { color: #888; margin-bottom: 1.25rem; font-size: 0.9rem; }
  section.feature { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; margin-bottom: 0.75rem; scroll-margin-top: 4.5rem; }
  section.feature details { padding: 0; }
  section.feature details summary {
    list-style: none; cursor: pointer; padding: 0.85rem 1.25rem;
    font-size: 1.05rem; color: #fb923c; font-weight: 600;
    display: flex; align-items: center; gap: 0.5rem;
    border-bottom: 1px solid transparent;
  }
  section.feature details summary::-webkit-details-marker { display: none; }
  section.feature details summary::before {
    content: '▸'; display: inline-block; transition: transform 0.15s ease; color: #888; font-size: 0.85rem;
  }
  section.feature details[open] summary::before { transform: rotate(90deg); }
  section.feature details[open] summary { border-bottom-color: #2a2a2a; }
  section.feature .body { padding: 1rem 1.25rem 1.25rem; }

  a { color: #60a5fa; }
  form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; }
  form + form { margin-top: 0.5rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: #aaa; }
  input, textarea, select { background: #222; border: 1px solid #444; border-radius: 4px; padding: 0.4rem 0.6rem; color: #eee; font-family: monospace; }
  textarea { min-height: 60px; min-width: 250px; }
  button { background: #f97316; color: #000; font-weight: 600; border: none; border-radius: 4px; padding: 0.5rem 1rem; cursor: pointer; font-family: inherit; }
  button:hover { background: #fb923c; }
  button.danger { background: #ef4444; color: #fff; }
  button.danger:hover { background: #f87171; }
  button.secondary { background: #333; color: #ddd; }
  button.secondary:hover { background: #444; }
  .links { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .links a { font-size: 0.85rem; background: #222; padding: 0.3rem 0.6rem; border-radius: 4px; text-decoration: none; color: #ddd; }
  .links a:hover { background: #333; }
  .note { color: #888; font-size: 0.85rem; margin-bottom: 0.75rem; }

  /* response history stack */
  #history-panel {
    position: fixed; right: 1rem; bottom: 1rem; width: 420px; max-width: calc(100vw - 2rem);
    display: flex; flex-direction: column; gap: 0.5rem; z-index: 40; pointer-events: none;
  }
  #history-panel .controls {
    align-self: flex-end; display: flex; gap: 0.4rem; pointer-events: auto;
  }
  #history-panel .controls button { font-size: 0.75rem; padding: 0.3rem 0.6rem; }
  .resp-card {
    pointer-events: auto;
    background: #111; border: 1px solid #333; border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.6);
    font-family: monospace; font-size: 0.82rem; overflow: hidden;
  }
  .resp-card.fade-1 { opacity: 0.85; }
  .resp-card.fade-2 { opacity: 0.7; }
  .resp-card.fade-3 { opacity: 0.55; }
  .resp-card.fade-4 { opacity: 0.4; }
  .resp-card .head {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.45rem 0.7rem; background: #181818; border-bottom: 1px solid #2a2a2a;
    cursor: pointer; user-select: none;
  }
  .resp-card .head .method { color: #fb923c; font-weight: 600; }
  .resp-card .head .path { color: #ddd; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .resp-card .head .status { font-size: 0.75rem; padding: 0.15rem 0.45rem; border-radius: 4px; background: #222; }
  .resp-card .head .status.ok { background: #166534; color: #4ade80; }
  .resp-card .head .status.err { background: #7f1d1d; color: #fca5a5; }
  .resp-card .head .dur { color: #777; font-size: 0.72rem; }
  .resp-card .head .close { background: none; border: none; color: #777; cursor: pointer; padding: 0 0.2rem; font-size: 0.9rem; }
  .resp-card .head .close:hover { color: #fff; }
  .resp-card .body pre {
    margin: 0; padding: 0.6rem 0.7rem; white-space: pre-wrap; word-break: break-word;
    max-height: 320px; overflow: auto; color: #cfcfcf;
  }
  .resp-card[data-collapsed="1"] .body { display: none; }

  /* mobile: sidebar becomes a horizontal pill bar */
  @media (max-width: 999px) {
    .layout { grid-template-columns: 1fr; padding: 0.75rem; }
    aside.sidebar {
      position: sticky; top: 3.25rem; max-height: none; overflow-x: auto; overflow-y: hidden;
      padding: 0.5rem 0.6rem;
    }
    aside.sidebar h3 { display: none; }
    aside.sidebar ul { display: flex; gap: 0.4rem; }
    aside.sidebar li a { white-space: nowrap; padding: 0.3rem 0.6rem; border-left: none; border-bottom: 2px solid transparent; }
    aside.sidebar li a.active { border-left-color: transparent; border-bottom-color: #f97316; }
    #history-panel { width: calc(100vw - 1rem); right: 0.5rem; bottom: 0.5rem; }
  }
`

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const CLIENT_JS = `
function formVal(id) { var el = document.getElementById(id); return el ? el.value : ''; }

// ── response history ──────────────────────────────────────────────────
var HISTORY_MAX = 5;
var historyEl = null;
var historyListEl = null;
function ensureHistoryUI() {
  if (historyEl) return;
  historyEl = document.createElement('div');
  historyEl.id = 'history-panel';
  historyEl.innerHTML = '<div class="controls"><button class="secondary" id="hist-clear">Clear all</button></div><div id="hist-list" style="display:flex;flex-direction:column;gap:0.5rem"></div>';
  document.body.appendChild(historyEl);
  historyListEl = document.getElementById('hist-list');
  document.getElementById('hist-clear').addEventListener('click', function () {
    historyListEl.innerHTML = '';
  });
}
function applyFade() {
  if (!historyListEl) return;
  var cards = historyListEl.querySelectorAll('.resp-card');
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.remove('fade-1', 'fade-2', 'fade-3', 'fade-4');
    if (i > 0) cards[i].classList.add('fade-' + Math.min(i, 4));
    cards[i].setAttribute('data-collapsed', i === 0 ? '0' : '1');
  }
}
function pushHistoryCard(method, path) {
  ensureHistoryUI();
  var card = document.createElement('div');
  card.className = 'resp-card';
  card.innerHTML =
    '<div class="head">' +
      '<span class="method"></span>' +
      '<span class="path"></span>' +
      '<span class="status">…</span>' +
      '<span class="dur"></span>' +
      '<button class="close" title="Close">×</button>' +
    '</div>' +
    '<div class="body"><pre></pre></div>';
  card.querySelector('.method').textContent = method;
  card.querySelector('.path').textContent = path;
  var head = card.querySelector('.head');
  head.addEventListener('click', function (ev) {
    if ((ev.target).classList.contains('close')) return;
    var collapsed = card.getAttribute('data-collapsed') === '1';
    card.setAttribute('data-collapsed', collapsed ? '0' : '1');
  });
  card.querySelector('.close').addEventListener('click', function (ev) {
    ev.stopPropagation();
    card.remove();
    applyFade();
  });
  historyListEl.insertBefore(card, historyListEl.firstChild);
  // prune past the max
  while (historyListEl.children.length > HISTORY_MAX) {
    historyListEl.removeChild(historyListEl.lastChild);
  }
  applyFade();
  card.setAttribute('data-collapsed', '0');
  return {
    setStatus: function (status, statusText, ok) {
      var el = card.querySelector('.status');
      el.textContent = status + ' ' + statusText;
      el.classList.add(ok ? 'ok' : 'err');
    },
    setDuration: function (ms) {
      card.querySelector('.dur').textContent = (ms / 1000).toFixed(2) + 's';
    },
    setError: function (msg) {
      var el = card.querySelector('.status');
      el.textContent = 'ERR';
      el.classList.add('err');
      card.querySelector('.body pre').textContent = msg;
    },
    append: function (chunk) { card.querySelector('.body pre').textContent += chunk; },
    set: function (text) { card.querySelector('.body pre').textContent = text; },
  };
}

// ── streaming-aware fetch wrapper ─────────────────────────────────────
async function api(method, path, body) {
  var card = pushHistoryCard(method, path);
  var start = performance.now();
  try {
    var opts = { method: method };
    if (body !== undefined) {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (typeof body !== 'string') opts.headers = { 'Content-Type': 'application/json' };
    }
    var res = await fetch(path, opts);
    card.setStatus(res.status, res.statusText || '', res.ok);
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    var te = (res.headers.get('transfer-encoding') || '').toLowerCase();
    var streaming = ct.indexOf('text/event-stream') !== -1 || te.indexOf('chunked') !== -1;
    if (streaming && res.body) {
      card.set('');
      try {
        var reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          card.append(r.value);
        }
      } catch (e) {
        card.append('\\n[stream error] ' + (e && e.message ? e.message : e));
      }
    } else if (ct.indexOf('json') !== -1) {
      var data = await res.json();
      card.set(JSON.stringify(data, null, 2));
    } else {
      card.set(await res.text());
    }
  } catch (e) {
    card.setError(e && e.message ? e.message : String(e));
  } finally {
    card.setDuration(performance.now() - start);
  }
}

// ── section activation + query param + intersection observer ─────────
function openSection(slug, opts) {
  opts = opts || {};
  var sec = document.getElementById(slug);
  if (!sec) return;
  var det = sec.querySelector('details');
  if (det) det.open = true;
  if (opts.scroll) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setActive(slug, { updateUrl: opts.updateUrl !== false });
}

function setActive(slug, opts) {
  opts = opts || {};
  var links = document.querySelectorAll('aside.sidebar a[data-slug]');
  for (var i = 0; i < links.length; i++) {
    links[i].classList.toggle('active', links[i].getAttribute('data-slug') === slug);
  }
  if (opts.updateUrl) {
    var u = new URL(location.href);
    u.searchParams.set('section', slug);
    history.replaceState(null, '', u.toString());
  }
}

function initSidebar() {
  var links = document.querySelectorAll('aside.sidebar a[data-slug]');
  for (var i = 0; i < links.length; i++) {
    (function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        openSection(a.getAttribute('data-slug'), { scroll: true });
      });
    })(links[i]);
  }
  var details = document.querySelectorAll('section.feature details');
  for (var j = 0; j < details.length; j++) {
    (function (d) {
      d.addEventListener('toggle', function () {
        if (d.open) {
          var slug = d.closest('section.feature').id;
          setActive(slug, { updateUrl: true });
        }
      });
    })(details[j]);
  }
}

function initObserver() {
  var sections = document.querySelectorAll('section.feature');
  if (!('IntersectionObserver' in window) || !sections.length) return;
  var visible = new Map();
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { visible.set(e.target.id, e.intersectionRatio); });
    var best = null;
    var bestR = 0;
    visible.forEach(function (r, id) { if (r > bestR) { bestR = r; best = id; } });
    if (best && bestR > 0) setActive(best, { updateUrl: false });
  }, { rootMargin: '-72px 0px -50% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });
  for (var i = 0; i < sections.length; i++) obs.observe(sections[i]);
}

function bootSections() {
  var params = new URLSearchParams(location.search);
  var requested = params.get('section');
  var first = document.querySelector('section.feature');
  var firstSlug = first ? first.id : null;
  var initial = (requested && document.getElementById(requested)) ? requested : firstSlug;
  // close all details that don't match initial
  var details = document.querySelectorAll('section.feature details');
  for (var i = 0; i < details.length; i++) {
    var slug = details[i].closest('section.feature').id;
    details[i].open = slug === initial;
  }
  if (initial) {
    setActive(initial, { updateUrl: false });
    if (requested && requested === initial) {
      var el = document.getElementById(initial);
      if (el) el.scrollIntoView({ block: 'start' });
    }
  }
}

window.addEventListener('popstate', function () { bootSections(); });
document.addEventListener('DOMContentLoaded', function () {
  initSidebar();
  initObserver();
  bootSections();
});
`

export function renderShell(sections: readonly Section[]): Response {
	const toc = sections.map(s => `<li><a href="?section=${s.slug}" data-slug="${s.slug}">${escapeHtml(s.title)}</a></li>`).join('')
	const body = sections
		.map(s =>
			`<section class="feature" id="${s.slug}"><details><summary>${escapeHtml(s.title)}</summary><div class="body">${s.html}</div></details></section>`
		)
		.join('\n')

	const document = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lopata Playground</title>
<style>${CSS}</style>
</head><body>
<header class="top">
  <h1>Lopata Playground</h1>
  <div class="top-actions">
    <a href="/__dashboard/traces" target="_blank" class="trace-link">Traces ↗</a>
    <a href="/__dashboard" target="_blank" class="btn-link">Open dashboard ↗</a>
  </div>
</header>
<div class="layout">
  <aside class="sidebar">
    <h3>Sections</h3>
    <ul>${toc}</ul>
  </aside>
  <main>
    <p class="subtitle">Local Cloudflare Worker runtime — every binding has its own playground section.</p>
    ${body}
  </main>
</div>
<script>${CLIENT_JS}</script>
</body></html>`

	return new Response(document, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
