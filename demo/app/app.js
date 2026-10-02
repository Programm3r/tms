// Device simulator for the browser. Behaves like the RN shell:
//   1. render immediately from the device cache, or from the compiled base file if there is none;
//   2. one conditional GET to this environment's BFF (If-None-Match = cached ETag);
//   3. 304 → keep the cache; 200 → replace content and ETag together.
// The device cache is localStorage, keyed by environment and language tag, and by ETag mode: GitHub's
// ETag (pass-through) and the BFF's content hash each get their own cache, so both can be compared.

import { FlowPlayer } from './flow.js';

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
const player = new FlowPlayer(document.querySelector('#flow'));
const ENVS = Object.keys(cfg.environments);
const BRANCH = { sit: 'sit', qa: 'qa', uat: 'uat', prod: 'main' };
const TAGS = ['en-US', 'fr-FR', 'fr-CI', 'pt-PT'];
const AUTO_SECONDS = 15;

const state = {
  env: store.get('ui:env') ?? 'sit',
  tag: store.get('ui:tag') ?? 'en-US',
  etagMode: store.get('ui:etagMode') === 'content' ? 'content' : 'github',
  active: null,          // content currently rendered
  renderedFrom: '',
  last: null,            // last launch result
  diff: null,            // { added, changed, removed } from the last 200 that replaced cached content
  changedKeys: new Set(),
  history: [],
  selected: null,        // history entry shown in the data flow diagram
  live: {},              // env -> version.json from GitHub Pages
  bases: {},
};
if (!ENVS.includes(state.env)) state.env = 'sit';

// ---------- helpers ----------
const cacheKey = (env, tag, mode = state.etagMode) => (mode === 'content' ? `cache:${env}:${tag}:content` : `cache:${env}:${tag}`);
const MODE_LABEL = { github: "GitHub's ETag", content: 'content hash' };
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
  const { env, tag, etagMode } = state;
  const key = cacheKey(env, tag, etagMode);
  const cached = cacheGet(key);
  const base = await baseFile(tag);

  state.active = cached?.content ?? null;
  state.renderedFrom = cached ? `device cache · ETag ${cached.etag}` : `compiled base file ${base.tag} (nothing cached for ${tag})`;
  state.changedKeys = new Set();
  render();

  const entry = {
    at: Date.now(),
    env,
    tag,
    mode: etagMode,
    sent: cached?.etag ?? null,
    device: { cacheKey: key, base: base.tag, cached: cached ? { etag: cached.etag, commit: cached.content?._meta?.commitId } : null },
  };
  const started = performance.now();
  try {
    const res = await fetch(`/bff/${env}/bootstrap/v1/localisation/${encodeURIComponent(tag)}`, {
      cache: 'no-store',
      headers: {
        'x-demo-etag-mode': etagMode,
        ...(cached ? { 'If-None-Match': cached.etag } : {}),
        ...($('#bypass').checked ? { 'x-demo-bypass-cdn': '1' } : {}),
      },
    });
    const text = await res.text();
    Object.assign(entry, {
      status: res.status,
      received: res.headers.get('etag'),
      bytes: new TextEncoder().encode(text).length,
      upstream: res.headers.get('x-upstream-status'),
      cdn: res.headers.get('x-upstream-cache'),
      ms: Math.round(performance.now() - started),
      trace: res.headers.get('x-trace') ? JSON.parse(decodeURIComponent(res.headers.get('x-trace'))) : null,
    });
    // Content mode: GitHub's ETag, which only the BFF sees, and what it was when the BFF last fetched.
    const c = entry.trace?.content;
    if (c) entry.github = { etag: c.upstreamEtag, before: c.stored?.upstreamEtag ?? null };

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
        entry.diff = { added: d.added.length, changed: d.changed.length, removed: d.removed.length };
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
  state.selected = entry;
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

/** Badges for the ETag the device sent and the one it received: did the file change? */
function etagBadges(e) {
  const b = (cls, text, title) => `<span class="badge sm ${cls}" title="${esc(title)}">${esc(text)}</span>`;
  if (!e.sent && !e.received) return { sent: b('neutral', 'none sent', 'Nothing cached, so no ETag to send'), received: b('neutral', 'none', 'No ETag in the response') };
  if (!e.sent) return { sent: b('neutral', 'none sent', 'Nothing cached, so no ETag to send'), received: b('info', 'new', 'First ETag for this file on the device') };
  if (!e.received) return { sent: b('neutral', 'sent', 'The device sent its cached ETag'), received: b('neutral', 'none', 'No ETag in the response') };
  return e.sent === e.received
    ? { sent: b('ok', 'still current', 'The cached ETag matches the current file'), received: b('ok', 'unchanged', 'Same ETag as sent: the file has not changed') }
    : { sent: b('warn', 'outdated', 'The cached ETag no longer matches the current file'), received: b('warn', 'changed', 'Different ETag from the one sent: the file changed') };
}

const OUTCOME = {
  first: ['ok', '200 · first download', 'Stored in the device cache together with its ETag.'],
  updated: ['warn', '200 · content updated', 'The ETag changed and the content is different. Cache and ETag were replaced together.'],
  'same-content': ['info', '200 · new ETag, same content', 'The site was redeployed (another environment published), so GitHub issued a new ETag although this file\'s content is identical.'],
  unchanged: ['ok', '304 · not modified', 'GitHub answered the forwarded If-None-Match; nothing was downloaded.'],
  error: ['bad', 'error', 'The device keeps what it has (cache or compiled base file).'],
};
const OUTCOME_CONTENT = {
  'same-content': ['info', '200 · new hash, same keys', 'Only _meta changed (this environment\'s branch moved on), which changes the file\'s bytes and so its hash. Every key and value is the same.'],
  unchanged: ['ok', '304 · not modified', 'The BFF compared the hash of the current file with If-None-Match; nothing was downloaded.'],
};
const githubEtagChanged = e => Boolean(e.github?.before && e.github.etag && e.github.before !== e.github.etag);
function outcomeOf(e) {
  const [kind, label, text] = (e.mode === 'content' && OUTCOME_CONTENT[e.outcome]) || OUTCOME[e.outcome];
  if (e.mode === 'content' && e.outcome === 'unchanged' && githubEtagChanged(e)) {
    return [kind, label, 'GitHub issued a new ETag (the site was redeployed), but the file\'s hash is the same, so the BFF answered 304. Nothing was downloaded.'];
  }
  return [kind, label, text];
}

/** Content mode: GitHub's ETag as the BFF saw it, and whether it changed since the BFF last fetched. */
function githubEtagRow(e) {
  if (!e.github) return '';
  const b = (cls, text, title) => `<span class="badge sm ${cls}" title="${esc(title)}">${esc(text)}</span>`;
  const badge = !e.github.before ? b('neutral', 'first fetch', 'The BFF had nothing stored for this file')
    : githubEtagChanged(e) ? b('warn', 'changed', `Was ${e.github.before} when the BFF last fetched: GitHub redeployed`)
    : b('ok', 'unchanged', 'Same as when the BFF last fetched');
  const decoded = decodeEtag(e.github.etag);
  return `<dt>GitHub's ETag (BFF only)</dt><dd><span class="mono">${esc(e.github.etag ?? '—')}</span> ${badge}${decoded ? ` <span class="muted">file time ${esc(decoded.mtime.toISOString().replace('.000Z', 'Z'))}, ${decoded.size} bytes</span>` : ''}</dd>`;
}

function renderLast() {
  const e = state.last;
  if (!e) return;
  const [kind, label, text] = outcomeOf(e);
  const statusLabel = e.outcome === 'error' ? `${e.status} · ${label}` : label;
  const tags = etagBadges(e);
  const decoded = decodeEtag(e.received ?? e.sent);
  const hashed = /^"sha256-/.test(e.received ?? e.sent ?? '');
  $('#last').innerHTML = `
    <div class="headline"><span class="badge ${kind}">${esc(statusLabel)}</span><span class="text">${esc(text)}</span></div>
    <dl class="facts">
      <dt>Request</dt><dd class="mono">GET /bff/${esc(e.env)}/bootstrap/v1/localisation/${esc(e.tag)}</dd>
      <dt>ETag mode</dt><dd>${e.mode === 'content' ? 'content hash: the BFF hashes the file and compares' : 'GitHub\'s ETag: the BFF passes it through'}</dd>
      <dt>If-None-Match sent</dt><dd><span class="mono">${esc(e.sent ?? '—')}</span> ${tags.sent}</dd>
      <dt>ETag received</dt><dd><span class="mono">${esc(e.received ?? '—')}</span> ${tags.received}</dd>
      ${decoded ? `<dt>ETag decoded</dt><dd>file time ${esc(decoded.mtime.toISOString().replace('.000Z', 'Z'))}, ${decoded.size} bytes <span class="muted">(GitHub Pages: "&lt;mtime&gt;-&lt;size&gt;")</span></dd>` : ''}
      ${hashed ? '<dt>ETag decoded</dt><dd>SHA-256 of the file\'s bytes (first 128 bits), computed by the BFF <span class="muted">(changes only when the content does)</span></dd>' : ''}
      ${githubEtagRow(e)}
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
  if (!d || d.count === 0) {
    el.innerHTML = e.mode === 'content'
      ? '<p>Same keys and values as before. Only <code>_meta</code> changed, and with it the hash.</p>'
      : '<p>Same keys and values as before. Only the ETag (and <code>_meta</code>) changed.</p>';
    return;
  }
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

const OUTCOME_LABEL = { first: 'first download', updated: 'updated', 'same-content': 'new ETag, same content', unchanged: 'not modified', error: 'error' };
const outcomeLabel = e => (e.mode === 'content' && e.outcome === 'same-content' ? 'new hash, same keys' : OUTCOME_LABEL[e.outcome]);

function renderFlow() {
  const e = state.selected;
  if (!e) return;
  const isLatest = e === state.history[0];
  $('#flowCaption').innerHTML = `<strong>${esc(e.env.toUpperCase())} / ${esc(e.tag)}</strong> at ${time(e.at)} · ${esc(MODE_LABEL[e.mode])} · ${esc(e.status)} ${esc(outcomeLabel(e))} · ${e.ms ?? '?'} ms${isLatest ? '' : ' <span class="muted">(older call)</span>'}`;
  if (player.entry !== e) player.load(e);
}

function renderHistory() {
  $('#history').innerHTML = state.history.map((e, i) => `
    <tr data-i="${i}" class="${e === state.selected ? 'selected' : ''}" title="Show this call in the data flow diagram">
      <td>${time(e.at)}</td>
      <td>${esc(e.env)} / ${esc(e.tag)} <span class="muted">· ${esc(MODE_LABEL[e.mode])}</span></td>
      <td><span class="mono">${esc(e.sent ?? '—')}</span> ${etagBadges(e).sent}</td>
      <td><strong>${esc(e.status)}</strong></td>
      <td><span class="mono">${esc(e.received ?? '—')}</span> ${etagBadges(e).received}</td>
      <td>${e.bytes ?? 0}</td>
      <td>${esc(e.cdn ?? '—')}</td>
      <td>${esc(outcomeLabel(e))}</td>
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
  renderFlow();
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
$('#etagMode').value = state.etagMode;
$('#etagMode').addEventListener('change', e => {
  state.etagMode = e.target.value;
  store.set('ui:etagMode', state.etagMode);
  select(state.env, state.tag);
});
$('#bypass').checked = store.get('ui:bypass') === true;
$('#bypass').addEventListener('change', e => store.set('ui:bypass', e.target.checked));
$('#history').addEventListener('click', e => {
  const row = e.target.closest('tr[data-i]');
  if (!row) return;
  state.selected = state.history[Number(row.dataset.i)];
  renderFlow();
  renderHistory();
  $('#flow').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
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
