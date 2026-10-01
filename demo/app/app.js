// Device simulator for the browser. Behaves like the RN shell:
//   1. render immediately from the device cache, or from the compiled base file if there is none;
//   2. one conditional GET to this environment's BFF (If-None-Match = cached ETag);
//   3. 304 → keep the cache; 200 → replace content and ETag together.
// The device cache is localStorage, keyed by environment and language tag.

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: cache lives only in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const memoryCache = new Map();
const cacheGet = k => store.get(k) ?? memoryCache.get(k) ?? null;
const cacheSet = (k, v) => { memoryCache.set(k, v); store.set(k, v); };
const cacheDel = k => { memoryCache.delete(k); store.del(k); };

const cfg = await (await fetch('/config.json', { cache: 'no-store' })).json();
const ENVS = Object.keys(cfg.environments);
const BRANCH = { sit: 'sit', qa: 'qa', uat: 'uat', prod: 'main' };
const TAGS = ['en-US', 'fr-FR', 'fr-CI', 'pt-PT'];
const AUTO_SECONDS = 15;

const state = {
  env: store.get('ui:env') ?? 'sit',
  tag: store.get('ui:tag') ?? 'en-US',
  active: null,          // content currently rendered
  renderedFrom: '',
  last: null,            // last launch result
  diff: null,            // { added, changed, removed } from the last 200 that replaced cached content
  changedKeys: new Set(),
  history: [],
  live: {},              // env -> version.json from GitHub Pages
  bases: {},
};
if (!ENVS.includes(state.env)) state.env = 'sit';

// ---------- helpers ----------
const cacheKey = (env, tag) => `cache:${env}:${tag}`;
const baseTagFor = tag => (tag.startsWith('fr-') ? 'fr-FR' : 'en-US');

async function baseFile(tag) {
  const b = baseTagFor(tag);
  state.bases[b] ??= await (await fetch(`/base/${b}.json`, { cache: 'no-store' })).json();
  return { tag: b, content: state.bases[b] };
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (!prefix && k === '_meta') continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

function diff(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const added = Object.keys(b).filter(k => !(k in a)).map(k => ({ key: k, value: b[k] }));
  const removed = Object.keys(a).filter(k => !(k in b)).map(k => ({ key: k, value: a[k] }));
  const changed = Object.keys(b).filter(k => k in a && a[k] !== b[k]).map(k => ({ key: k, from: a[k], to: b[k] }));
  return { added, removed, changed, count: added.length + removed.length + changed.length };
}

const lookup = (content, flatKey) => flatKey.split('.').reduce((o, k) => o?.[k], content);

function decodeEtag(etag) {
  const m = /^(W\/)?"([0-9a-f]+)-([0-9a-f]+)"$/.exec(etag ?? '');
  if (!m) return null;
  return { mtime: new Date(parseInt(m[2], 16) * 1000), size: parseInt(m[3], 16), weak: Boolean(m[1]) };
}

const short = sha => (sha ? sha.slice(0, 7) : '—');
const commitLink = sha => (sha ? `<a href="https://github.com/${cfg.repo}/commit/${sha}" target="_blank" rel="noopener">${short(sha)}</a>` : '—');
const time = d => new Date(d).toLocaleTimeString();
function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---------- launch: what the shell does on app start ----------
async function launch() {
  const { env, tag } = state;
  const key = cacheKey(env, tag);
  const cached = cacheGet(key);
  const base = await baseFile(tag);

  state.active = cached?.content ?? null;
  state.renderedFrom = cached ? `device cache · ETag ${cached.etag}` : `compiled base file ${base.tag} (nothing cached for ${tag})`;
  state.changedKeys = new Set();
  render();

  const entry = { at: Date.now(), env, tag, sent: cached?.etag ?? null };
  const started = performance.now();
  try {
    const res = await fetch(`/bff/${env}/bootstrap/v1/localisation/${encodeURIComponent(tag)}`, {
      cache: 'no-store',
      headers: cached ? { 'If-None-Match': cached.etag } : {},
    });
    const text = await res.text();
    Object.assign(entry, {
      status: res.status,
      received: res.headers.get('etag'),
      bytes: new TextEncoder().encode(text).length,
      upstream: res.headers.get('x-upstream-status'),
      cdn: res.headers.get('x-upstream-cache'),
      ms: Math.round(performance.now() - started),
    });

    if (res.status === 304) {
      entry.outcome = 'unchanged';
      state.diff = null;
    } else if (res.status === 200) {
      const content = JSON.parse(text);   // must parse before it replaces anything
      const d = cached ? diff(cached.content, content) : null;
      cacheSet(key, { etag: entry.received, storedAt: new Date().toISOString(), content });
      state.active = content;
      state.renderedFrom = `device cache · ETag ${entry.received} (just downloaded)`;
      if (!cached) {
        entry.outcome = 'first';
        state.diff = null;
      } else if (d.count === 0) {
        entry.outcome = 'same-content';
        state.diff = d;
      } else {
        entry.outcome = 'updated';
        state.diff = d;
        state.changedKeys = new Set([...d.added, ...d.changed].map(x => x.key));
      }
    } else {
      entry.outcome = 'error';
      entry.error = text;
    }
  } catch (e) {
    Object.assign(entry, { status: 'network', outcome: 'error', error: e.message, ms: Math.round(performance.now() - started) });
  }

  state.last = entry;
  state.history.unshift(entry);
  state.history.length = Math.min(state.history.length, 40);
  render();
  refreshLive();
}

// ---------- GitHub Pages overview (demo only: the device itself only talks to its BFF) ----------
async function refreshLive() {
  await Promise.all(ENVS.map(async env => {
    try {
      const res = await fetch(`${cfg.siteUrl}/${env}/version.json?nocache=${Date.now()}`, { cache: 'no-store' });
      state.live[env] = res.ok ? await res.json() : null;
    } catch {
      state.live[env] = null;
    }
  }));
  renderEnvs();
}

// ---------- rendering ----------
function s(nsKey, vars) {
  const flatKey = nsKey.replace(':', '.');
  let value = lookup(state.active, flatKey);
  let cls = '';
  if (value === undefined) {
    const base = state.bases[baseTagFor(state.tag)];
    value = lookup(base, flatKey);
    cls = value === undefined ? 'missing' : 'fallback';
  }
  if (value === undefined) return `<span class="str missing" data-key="${esc(nsKey)}" title="Key not in this environment yet">${esc(nsKey)}</span>`;
  const text = String(value).replace(/{{\s*([\w.]+)\s*}}/g, (m, v) => vars?.[v] ?? m);
  if (state.changedKeys.has(flatKey)) cls += ' changed';
  const title = cls.includes('fallback') ? `${nsKey} (from the compiled base file)` : nsKey;
  return `<span class="str ${cls}" data-key="${esc(nsKey)}" title="${esc(title)}">${esc(text)}</span>`;
}

function renderPhone() {
  const phone = $('#phone');
  phone.classList.toggle('show-keys', $('#showKeys').checked);
  phone.innerHTML = `
    <div class="status"><span>9:41</span><span>MTN · ${esc(state.env.toUpperCase())} · ${esc(state.tag)}</span></div>
    <div class="appbar">${s('puk:section.puk-retrieval')}</div>
    <div class="tabs">
      <span class="tab active">${s('puk:section.tab-myself')}</span>
      <span class="tab">${s('puk:section.tab-someone-else')}</span>
    </div>
    <div class="body">
      <h3>${s('puk:section.enter-number')}</h3>
      <p>${s('puk:section.enter-number-description')}</p>
      <div class="field"><span class="label">${s('puk:cellPhone.phone')}</span>083 123 4567</div>
      <button class="cta" type="button" tabindex="-1">${s('puk:section.request-puk')}</button>
      <p class="help">${s('puk:section.help-link')}</p>
      <div class="info">
        <strong>${s('puk:section.info-puk-title')}</strong>
        <p>${s('puk:section.info-puk-description')}</p>
      </div>
      <div class="kmn">
        <strong>${s('kmn:title')}</strong>
        <p>${s('kmn:your-number', { msisdn: '083 123 4567' })}</p>
        <div class="row"><button class="ghost" type="button" tabindex="-1">${s('kmn:show-number')}</button><span>${s('kmn:section.refresh')}</span></div>
      </div>
      <div class="row"><button class="ghost" type="button" tabindex="-1">${s('puk:cancel')}</button><span>${s('puk:just-moment')}</span></div>
    </div>`;
  $('#renderedFrom').textContent = `Rendered from: ${state.renderedFrom}`;
}

const OUTCOME = {
  first: ['ok', '200 · first download', 'Stored in the device cache together with its ETag.'],
  updated: ['warn', '200 · content updated', 'The ETag changed and the content is different. Cache and ETag were replaced together.'],
  'same-content': ['info', '200 · new ETag, same content', 'The site was redeployed (another environment published), so GitHub issued a new ETag although this file\'s content is identical.'],
  unchanged: ['ok', '304 · not modified', 'GitHub answered the forwarded If-None-Match; nothing was downloaded.'],
  error: ['bad', 'error', 'The device keeps what it has (cache or compiled base file).'],
};

function renderLast() {
  const e = state.last;
  if (!e) return;
  const [kind, label, text] = OUTCOME[e.outcome];
  const statusLabel = e.outcome === 'error' ? `${e.status} · ${label}` : label;
  const sameEtag = e.sent && e.received ? (e.sent === e.received ? 'same as sent' : 'different from sent') : '';
  const decoded = decodeEtag(e.received ?? e.sent);
  $('#last').innerHTML = `
    <div class="headline"><span class="badge ${kind}">${esc(statusLabel)}</span><span class="text">${esc(text)}</span></div>
    <dl class="facts">
      <dt>Request</dt><dd class="mono">GET /bff/${esc(e.env)}/bootstrap/v1/localisation/${esc(e.tag)}</dd>
      <dt>If-None-Match sent</dt><dd class="mono">${esc(e.sent ?? '— (nothing cached)')}</dd>
      <dt>ETag received</dt><dd class="mono">${esc(e.received ?? '—')} ${sameEtag ? `<span class="muted">(${sameEtag})</span>` : ''}</dd>
      ${decoded ? `<dt>ETag decoded</dt><dd>file time ${esc(decoded.mtime.toISOString().replace('.000Z', 'Z'))}, ${decoded.size} bytes <span class="muted">(GitHub Pages: "&lt;mtime&gt;-&lt;size&gt;")</span></dd>` : ''}
      <dt>Body</dt><dd>${e.bytes ?? 0} bytes in ${e.ms ?? '?'} ms</dd>
      <dt>BFF → GitHub</dt><dd>${esc(e.upstream ?? '—')} ${e.cdn ? `<span class="muted">(GitHub CDN: ${esc(e.cdn)})</span>` : ''}</dd>
      ${e.error ? `<dt>Error</dt><dd class="mono">${esc(e.error)}</dd>` : ''}
    </dl>`;
}

function renderChanges() {
  const e = state.last;
  const d = state.diff;
  const el = $('#changes');
  if (!e) return;
  if (e.outcome === 'unchanged') { el.innerHTML = '<p>No change: <strong>304</strong>, the cached content is current.</p>'; return; }
  if (e.outcome === 'first') { el.innerHTML = '<p>First download for this environment and language: nothing to compare with.</p>'; return; }
  if (e.outcome === 'error') { el.innerHTML = '<p>Nothing changed on the device.</p>'; return; }
  if (!d || d.count === 0) { el.innerHTML = '<p>Same keys and values as before. Only the ETag (and <code>_meta</code>) changed.</p>'; return; }
  const items = [
    ...d.added.map(x => `<li><span class="pill new">NEW</span> <span class="k">${esc(x.key)}</span> = "${esc(x.value)}"</li>`),
    ...d.changed.map(x => `<li><span class="pill chg">CHANGED</span> <span class="k">${esc(x.key)}</span>: <span class="old">"${esc(x.from)}"</span> → "${esc(x.to)}"</li>`),
    ...d.removed.map(x => `<li><span class="pill">REMOVED</span> <span class="k">${esc(x.key)}</span></li>`),
  ];
  el.innerHTML = `<p>${d.count} key(s) differ from the previous cached version:</p><ul class="diff">${items.join('')}</ul>`;
}

function renderCache() {
  const c = cacheGet(cacheKey(state.env, state.tag));
  const live = state.live[state.env];
  if (!c) {
    $('#cache').innerHTML = `<p class="muted">Nothing cached for ${esc(state.env)} / ${esc(state.tag)}. The app renders from the compiled base file until the first download.</p>`;
    return;
  }
  const meta = c.content?._meta ?? {};
  const upToDate = live ? (live.commitId === meta.commitId ? '<span class="badge ok">matches what the site serves</span>' : '<span class="badge warn">site has a newer commit: launch to update</span>') : '';
  $('#cache').innerHTML = `
    <dl class="facts">
      <dt>Key</dt><dd class="mono">${esc(cacheKey(state.env, state.tag))}</dd>
      <dt>ETag</dt><dd class="mono">${esc(c.etag)}</dd>
      <dt>Stored</dt><dd>${esc(new Date(c.storedAt).toLocaleString())}</dd>
      <dt>_meta.commitId</dt><dd>${commitLink(meta.commitId)} ${upToDate}</dd>
      <dt>_meta.publishedAt</dt><dd>${esc(meta.publishedAt ?? '—')}</dd>
    </dl>`;
}

function renderHistory() {
  const label = { first: 'first download', updated: 'updated', 'same-content': 'new ETag, same content', unchanged: 'not modified', error: 'error' };
  $('#history').innerHTML = state.history.map(e => `
    <tr>
      <td>${time(e.at)}</td>
      <td>${esc(e.env)} / ${esc(e.tag)}</td>
      <td class="mono">${esc(e.sent ?? '—')}</td>
      <td><strong>${esc(e.status)}</strong></td>
      <td class="mono">${esc(e.received ?? '—')}</td>
      <td>${e.bytes ?? 0}</td>
      <td>${esc(e.cdn ?? '—')}</td>
      <td>${label[e.outcome]}</td>
    </tr>`).join('');
}

function renderKeys() {
  const flat = flatten(state.active);
  const q = $('#filter').value.trim().toLowerCase();
  const rows = Object.entries(flat).filter(([k, v]) => !q || k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q));
  const added = new Set(state.diff?.added.map(x => x.key));
  $('#keyCount').textContent = state.active ? `(${Object.keys(flat).length})` : '';
  $('#keys').innerHTML = state.active
    ? rows.map(([k, v]) => {
      const isNew = added.has(k);
      const isChanged = state.changedKeys.has(k);
      return `<tr class="${isChanged ? 'is-changed' : ''}"><td>${esc(k)}${isNew ? '<span class="pill new">NEW</span>' : isChanged ? '<span class="pill chg">CHANGED</span>' : ''}</td><td>${esc(v)}</td></tr>`;
    }).join('')
    : '<tr><td class="muted">No downloaded content yet.</td></tr>';
}

function renderEnvs() {
  $('#envs').innerHTML = ENVS.map(env => {
    const v = state.live[env];
    const allow = cfg.environments[env].tags;
    return `<button type="button" class="env ${env === state.env ? 'selected' : ''}" data-env="${env}">
      <div class="name"><span>${env.toUpperCase()}</span><span class="muted mono">branch ${BRANCH[env]}</span></div>
      <div class="meta">${v ? `serves ${short(v.commitId)} · published ${ago(v.publishedAt)}` : 'not published'}</div>
      <div class="tags">files: ${v ? v.tags.join(', ') : '—'}</div>
      <div class="tags muted">BFF allowlist: ${allow.join(', ')}</div>
    </button>`;
  }).join('');
  renderCache();
}

function render() {
  renderPhone();
  renderLast();
  renderChanges();
  renderCache();
  renderHistory();
  renderKeys();
  renderEnvs();
}

// ---------- controls ----------
function fillSelect(sel, values, current, label = v => v) {
  sel.innerHTML = values.map(v => `<option value="${v}" ${v === current ? 'selected' : ''}>${label(v)}</option>`).join('');
}
function fillTags() {
  const allow = cfg.environments[state.env].tags;
  fillSelect($('#tag'), TAGS, state.tag, t => (allow.includes(t) ? t : `${t} (not allowlisted here)`));
}
fillSelect($('#env'), ENVS, state.env, e => `${e.toUpperCase()} (branch ${BRANCH[e]})`);
fillTags();

function select(env, tag) {
  state.env = env;
  state.tag = tag;
  store.set('ui:env', env);
  store.set('ui:tag', tag);
  $('#env').value = env;
  fillTags();
  state.diff = null;
  state.last = null;
  $('#last').innerHTML = '<p class="muted">Press <strong>Launch app</strong>.</p>';
  $('#changes').innerHTML = '<p class="muted">Nothing yet.</p>';
  launch();
}

$('#env').addEventListener('change', e => select(e.target.value, state.tag));
$('#tag').addEventListener('change', e => select(state.env, e.target.value));
$('#envs').addEventListener('click', e => {
  const btn = e.target.closest('[data-env]');
  if (btn) select(btn.dataset.env, state.tag);
});
$('#launch').addEventListener('click', launch);
$('#clear').addEventListener('click', () => {
  cacheDel(cacheKey(state.env, state.tag));
  state.active = null;
  state.diff = null;
  state.changedKeys = new Set();
  state.renderedFrom = 'nothing cached: press Launch app';
  render();
});
$('#showKeys').addEventListener('change', renderPhone);
$('#filter').addEventListener('input', renderKeys);

let remaining = AUTO_SECONDS;
setInterval(() => {
  if (!$('#auto').checked) { $('#countdown').textContent = ''; remaining = AUTO_SECONDS; return; }
  remaining -= 1;
  $('#countdown').textContent = `(${remaining}s)`;
  if (remaining <= 0) { remaining = AUTO_SECONDS; launch(); }
}, 1000);

refreshLive();
launch();
