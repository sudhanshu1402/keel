import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Keel } from './runtime.js';
import type { Store } from './store/types.js';

export interface DashboardOptions {
  store: Store;
  /**
   * When provided, the Resume and Send-signal actions execute against this
   * engine (its workflows must be registered). Without it the dashboard is a
   * read-only observability view and signals are only stored.
   */
  keel?: Keel;
}

/** Max accepted request body, to stop an unbounded buffer from exhausting memory. */
const MAX_BODY_BYTES = 1_000_000;

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(body);
}

class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reject a state-changing request that a browser on another origin forged. A
 * cross-origin POST always carries an `Origin` header whose host differs from
 * the dashboard's; a same-origin request matches (or omits Origin, as
 * non-browser clients like curl do). Returns true when the request should be
 * refused.
 */
function isCrossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  keel?: Keel,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Only POSTs mutate state; reject a browser POST forged from another origin
  // (CSRF) before doing any work.
  if (method === 'POST' && isCrossOrigin(req)) {
    json(res, 403, { error: 'cross-origin request refused' });
    return;
  }

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (method === 'GET' && path === '/api/runs') {
    const runs = await store.listRuns();
    runs.sort((a, b) => b.createdAt - a.createdAt);
    json(res, 200, { runs, engine: Boolean(keel) });
    return;
  }

  const detail = path.match(/^\/api\/runs\/([^/]+)$/);
  if (method === 'GET' && detail) {
    const run = await store.getRun(decodeURIComponent(detail[1]!));
    if (!run) {
      json(res, 404, { error: 'run not found' });
      return;
    }
    const steps = await store.listSteps(run.id);
    steps.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    json(res, 200, { run, steps });
    return;
  }

  const resume = path.match(/^\/api\/runs\/([^/]+)\/resume$/);
  if (method === 'POST' && resume) {
    if (!keel) {
      json(res, 400, { error: 'no engine attached; resume needs registered workflows' });
      return;
    }
    try {
      const result = await keel.resume(decodeURIComponent(resume[1]!));
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const signal = path.match(/^\/api\/runs\/([^/]+)\/signal$/);
  if (method === 'POST' && signal) {
    const runId = decodeURIComponent(signal[1]!);
    const ctype = req.headers['content-type'] ?? '';
    if (!ctype.includes('application/json')) {
      json(res, 415, { error: 'content-type must be application/json' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        json(res, 413, { error: 'request body too large' });
        return;
      }
      throw err;
    }
    let parsed: { name?: string; value?: unknown };
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      json(res, 400, { error: 'invalid JSON body' });
      return;
    }
    if (!parsed.name) {
      json(res, 400, { error: 'signal name is required' });
      return;
    }
    if (keel) {
      const result = await keel.sendSignal(runId, parsed.name, parsed.value);
      json(res, 200, { delivered: true, result: result ?? null });
    } else {
      await store.saveSignal({
        runId,
        name: parsed.name,
        value: parsed.value,
        createdAt: Date.now(),
      });
      json(res, 200, { delivered: false, stored: true });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
}

/** Build (but do not start) the dashboard HTTP server. */
export function createDashboard(opts: DashboardOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, opts.store, opts.keel).catch((err) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Build and start the dashboard, resolving once it is listening.
 *
 * The dashboard has no authentication and exposes Resume/Cancel/Signal
 * controls, so it binds to loopback (`127.0.0.1`) by default. Binding to any
 * other host (e.g. `0.0.0.0`) exposes those controls to the network; that is
 * refused unless you pass `allowRemote: true` to acknowledge the risk and put
 * your own auth/proxy in front of it.
 */
export function startDashboard(
  opts: DashboardOptions & { port?: number; host?: string; allowRemote?: boolean },
): Promise<{ server: Server; port: number }> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    if (!opts.allowRemote) {
      throw new Error(
        `refusing to bind keel dashboard to non-loopback host "${host}": it has no authentication and would expose Resume/Cancel/Signal to the network. Pass allowRemote:true to override, and put it behind your own auth or proxy.`,
      );
    }
    process.emitWarning(
      `keel dashboard bound to "${host}" with no authentication: anyone who can reach it can resume, cancel, or signal runs.`,
    );
  }
  const server = createDashboard(opts);
  return new Promise((resolve) => {
    server.listen(opts.port ?? 4500, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 4500);
      resolve({ server, port });
    });
  });
}

// Single-file tokyonight UI. No external assets so the strict-CSP-free local
// page stays fully self-contained and works offline.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>keel dashboard</title>
<style>
  :root {
    --bg:#1a1b26; --surface:#24283b; --surface2:#1f2335; --fg:#c0caf5;
    --muted:#565f89; --blue:#7aa2f7; --purple:#bb9af7; --green:#9ece6a;
    --red:#f7768e; --yellow:#e0af68; --cyan:#7dcfff; --border:#2f3549;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { padding:16px 22px; border-bottom:1px solid var(--border);
    display:flex; align-items:baseline; gap:12px; }
  header h1 { margin:0; font-size:18px; color:var(--purple); letter-spacing:.5px; }
  header .sub { color:var(--muted); font-size:12px; }
  .wrap { display:grid; grid-template-columns:minmax(380px,1fr) minmax(420px,1.2fr);
    gap:0; height:calc(100vh - 59px); }
  .col { overflow:auto; padding:16px 22px; }
  .col.left { border-right:1px solid var(--border); }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:1px;
    color:var(--muted); margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border);
    font-size:13px; }
  th { color:var(--muted); font-weight:600; }
  tr.run { cursor:pointer; }
  tr.run:hover td { background:var(--surface); }
  tr.run.active td { background:var(--surface2); }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px;
    font-size:11px; font-weight:700; }
  .s-completed { background:rgba(158,206,106,.15); color:var(--green); }
  .s-running   { background:rgba(122,162,247,.15); color:var(--blue); }
  .s-paused    { background:rgba(224,175,104,.15); color:var(--yellow); }
  .s-queued    { background:rgba(125,207,255,.15); color:var(--cyan); }
  .s-failed    { background:rgba(247,118,142,.15); color:var(--red); }
  .s-pending   { background:rgba(86,95,137,.2); color:var(--muted); }
  .id { color:var(--cyan); }
  .step { border:1px solid var(--border); border-radius:8px; padding:10px 12px;
    margin-bottom:10px; background:var(--surface2); }
  .step .top { display:flex; justify-content:space-between; gap:10px; }
  .step .name { color:var(--blue); font-weight:700; }
  .step .meta { color:var(--muted); font-size:12px; margin-top:4px; }
  .step pre { margin:6px 0 0; white-space:pre-wrap; word-break:break-word;
    color:var(--fg); background:var(--bg); padding:8px; border-radius:6px;
    font-size:12px; max-height:160px; overflow:auto; }
  .err { color:var(--red); }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0 18px; }
  button { background:var(--blue); color:#1a1b26; border:0; border-radius:6px;
    padding:7px 12px; font:inherit; font-weight:700; cursor:pointer; }
  button.ghost { background:var(--surface); color:var(--fg);
    border:1px solid var(--border); }
  button:disabled { opacity:.4; cursor:not-allowed; }
  input { background:var(--bg); border:1px solid var(--border); color:var(--fg);
    border-radius:6px; padding:7px 10px; font:inherit; }
  .empty { color:var(--muted); padding:30px 0; text-align:center; }
  .row-gap { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
</style>
</head>
<body>
<header>
  <h1>keel</h1>
  <span class="sub">durable execution &middot; local dashboard</span>
  <span class="sub" id="engine"></span>
</header>
<div class="wrap">
  <div class="col left">
    <h2>Runs</h2>
    <table>
      <thead><tr><th>id</th><th>workflow</th><th>status</th><th>updated</th></tr></thead>
      <tbody id="runs"></tbody>
    </table>
    <div class="empty" id="runs-empty" style="display:none">no runs yet</div>
  </div>
  <div class="col">
    <h2>Detail</h2>
    <div id="detail"><div class="empty">select a run</div></div>
  </div>
</div>
<script>
let selected = null;
let hasEngine = false;
const ESC = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','\`':'&#96;','=':'&#61;','/':'&#47;'};
const esc = (s) => String(s).replace(/[&<>"'\`=\\/]/g, (c) => ESC[c]);
const fmt = (t) => t ? new Date(t).toLocaleTimeString() : '-';
const badge = (s) => '<span class="badge s-' + esc(s) + '">' + esc(s) + '</span>';

async function loadRuns() {
  const data = await (await fetch('/api/runs')).json();
  hasEngine = data.engine;
  document.getElementById('engine').textContent = hasEngine ? '' : '(read-only)';
  const tbody = document.getElementById('runs');
  document.getElementById('runs-empty').style.display = data.runs.length ? 'none' : 'block';
  tbody.innerHTML = data.runs.map((r) =>
    '<tr class="run ' + (r.id === selected ? 'active' : '') + '" data-id="' + esc(r.id) + '">' +
    '<td class="id">' + esc(r.id) + '</td><td>' + esc(r.workflowName) + '</td>' +
    '<td>' + badge(r.status) + '</td><td>' + fmt(r.updatedAt) + '</td></tr>'
  ).join('');
  for (const tr of tbody.querySelectorAll('tr.run')) {
    tr.onclick = () => { selected = tr.dataset.id; loadDetail(); loadRuns(); };
  }
  if (selected) loadDetail();
}

async function loadDetail() {
  if (!selected) return;
  const res = await fetch('/api/runs/' + encodeURIComponent(selected));
  const el = document.getElementById('detail');
  if (!res.ok) { el.innerHTML = '<div class="empty">run not found</div>'; return; }
  const { run, steps } = await res.json();
  const canResume = run.status === 'paused' || run.status === 'failed';
  let html = '<div class="row-gap"><span class="id">' + esc(run.id) + '</span>' + badge(run.status) + '</div>';
  if (run.error) html += '<div class="err" style="margin-top:8px">' + esc(run.error) + '</div>';
  html += '<div class="actions">';
  html += '<button ' + (canResume && hasEngine ? '' : 'disabled') + ' onclick="doResume()">Resume</button>';
  html += '<input id="sig-name" placeholder="signal name" />';
  html += '<input id="sig-val" placeholder="value (json)" />';
  html += '<button class="ghost" onclick="doSignal()">Send signal</button>';
  html += '</div>';
  html += steps.length ? steps.map(renderStep).join('') : '<div class="empty">no steps recorded</div>';
  el.innerHTML = html;
}

function renderStep(s) {
  let h = '<div class="step"><div class="top"><span class="name">' + esc(s.name) + '</span>' + badge(s.status) + '</div>';
  const bits = [];
  bits.push('attempts: ' + s.attempts);
  if (s.tokensIn != null || s.tokensOut != null) bits.push('tokens: ' + (s.tokensIn||0) + ' in / ' + (s.tokensOut||0) + ' out');
  if (s.wakeAt) bits.push('wakeAt: ' + fmt(s.wakeAt));
  h += '<div class="meta">' + bits.join(' &middot; ') + '</div>';
  if (s.result !== undefined) h += '<pre>' + esc(JSON.stringify(s.result, null, 2)) + '</pre>';
  if (s.error) h += '<div class="err" style="margin-top:6px">' + esc(s.error) + '</div>';
  return h + '</div>';
}

async function doResume() {
  await fetch('/api/runs/' + encodeURIComponent(selected) + '/resume', { method:'POST' });
  loadRuns();
}
async function doSignal() {
  const name = document.getElementById('sig-name').value.trim();
  if (!name) return;
  let value = document.getElementById('sig-val').value;
  try { value = value ? JSON.parse(value) : null; } catch (e) { /* send as string */ }
  await fetch('/api/runs/' + encodeURIComponent(selected) + '/signal', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ name, value }),
  });
  loadRuns();
}

loadRuns();
setInterval(loadRuns, 1500);
</script>
</body>
</html>`;
