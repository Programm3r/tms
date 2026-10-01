// Draws the data flow of one launch as an SVG sequence diagram, from the values the call produced:
// the device's own bookkeeping plus the BFF's x-trace header (what it checked, what it asked GitHub,
// and what GitHub's CDN answered).

const LANES = {
  device: { x: 140, title: 'Device app', sub: 'browser · localStorage cache' },
  bff: { x: 400, title: 'Bootstrap BFF', sub: '' },
  cdn: { x: 660, title: 'GitHub CDN edge', sub: 'Fastly' },
  origin: { x: 920, title: 'GitHub Pages origin', sub: 'programm3r.github.io' },
};
const WIDTH = 1060;
const LINE = 14;
const NOTE_W = 236;
const WRAP = 36;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = sha => (sha ? sha.slice(0, 7) : '—');
const STATUS = { 200: '200 OK', 304: '304 Not Modified', 400: '400 Bad Request', 404: '404 Not Found', 502: '502 Bad Gateway', 504: '504 Gateway Timeout' };
const statusLine = s => STATUS[s] ?? String(s);

function wrap(text, max = WRAP) {
  const out = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (line && (line + ' ' + word).length > max) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Turns one history entry into diagram steps. */
export function buildSteps(e) {
  const steps = [];
  const note = (lane, lines, tone = 'plain') => steps.push({ type: 'note', lane, lines: lines.filter(Boolean), tone });
  const msg = (from, to, lines, tone, dashed = false) => steps.push({ type: 'msg', from, to, lines: lines.filter(Boolean), tone, dashed });
  const ENV = e.env.toUpperCase();

  note('device', e.device.cached
    ? [`Launch: read ${e.device.cacheKey}`, `cached ETag ${e.device.cached.etag}`, `commit ${short(e.device.cached.commit)}`, 'Render the screen from the cache now']
    : [`Launch: read ${e.device.cacheKey}`, 'nothing cached', `Render from compiled base ${e.device.base} now`]);
  msg('device', 'bff', [
    `GET /bootstrap/v1/localisation/${e.tag}`,
    e.sent ? `If-None-Match: ${e.sent}` : '(no If-None-Match: nothing cached)',
  ], 'req');

  if (e.status === 'network') {
    note('device', ['BFF unreachable', e.error, 'Keep what is on screen'], 'bad');
    return steps;
  }

  const t = e.trace;
  if (!t) {
    msg('bff', 'device', [statusLine(e.status)], e.status < 400 ? 'ok' : 'bad', true);
    return steps;
  }

  if (t.allowlisted === false) {
    note('bff', [`${e.tag} is not on the ${ENV} allowlist`, 'Reject. No call to GitHub.'], 'bad');
    msg('bff', 'device', ['400 Bad Request', '{"error":"unsupported_tag"}', 'no ETag'], 'bad', true);
    note('device', ['Keep the cached file or the', 'compiled base file on screen']);
    return steps;
  }

  note('bff', [
    `${e.tag} is on the ${ENV} allowlist ✓`,
    'Build the upstream request:',
    '· force Accept-Encoding: identity',
    e.sent ? '· forward If-None-Match unchanged' : '· nothing to forward',
  ]);

  const u = t.upstream;
  const path = new URL(u.url).pathname;
  msg('bff', 'cdn', [`GET ${path}`, 'Accept-Encoding: identity', u.request['if-none-match'] && `If-None-Match: ${u.request['if-none-match']}`], 'req');

  if (u.error) {
    note('bff', [`GitHub did not answer: ${u.error}`, `after ${u.ms} ms`], 'bad');
    msg('bff', 'device', [statusLine(e.status), 'JSON error, no ETag'], 'bad', true);
    note('device', ['Keep the cached file or the', 'compiled base file on screen']);
    return steps;
  }

  const h = u.headers ?? {};
  const xCache = h['x-cache'] ?? '';
  const pop = (h['x-served-by'] ?? '').split(',').pop().trim();
  const hit = /HIT/.test(xCache);
  if (hit) {
    note('cdn', [
      `Cache HIT at ${pop || 'edge'}`,
      `cached ${h.age ?? '?'} s ago (max-age=600)`,
      u.status === 304 ? 'If-None-Match equals its ETag → 304' : 'serve its cached copy',
      'origin not contacted',
    ]);
  } else {
    note('cdn', [`Cache ${xCache || 'MISS'} at ${pop || 'edge'}`, 'fetch the file from the origin']);
    msg('cdn', 'origin', [`GET ${path}`], 'req');
    note('origin', [
      `${path.split('/').pop()} in the deployed site`,
      h['last-modified'] && `Last-Modified: ${h['last-modified']}`,
      'ETag = "<file time hex>-<size hex>"',
    ]);
    msg('origin', 'cdn', ['file + ETag', h.etag], 'plain', true);
    note('cdn', [u.status === 304 ? 'If-None-Match equals the ETag → 304' : 'store at the edge, answer 200']);
  }

  msg('cdn', 'bff', [
    statusLine(u.status),
    h.etag && `ETag: ${h.etag}`,
    u.status === 200 ? `${u.bytes} bytes · ${h['cache-control'] ?? ''}` : u.status === 304 ? '0 bytes' : 'HTML error page',
    `${u.ms} ms`,
  ], u.status === 200 || u.status === 304 ? 'ok' : 'bad', true);

  if (u.status === 200 || u.status === 304) {
    note('bff', ['Pass through unchanged:', 'status, ETag and body', 'set Cache-Control: max-age=300', 'store nothing']);
  } else if (u.status === 404) {
    note('bff', ['GitHub 404 is an HTML page with', 'its own ETag: drop both and', 'answer with the BFF\'s JSON 404'], 'bad');
  } else {
    note('bff', [`Unexpected upstream ${u.status}`, 'answer 502, never partial content'], 'bad');
  }

  msg('bff', 'device', [
    statusLine(e.status),
    e.received ? `ETag: ${e.received}` : 'no ETag',
    `${e.bytes} bytes · ${e.ms} ms total (BFF ${t.bffMs} ms)`,
  ], e.status === 200 || e.status === 304 ? 'ok' : 'bad', true);

  const d = e.diff;
  const after = {
    unchanged: ['304: keep the cached file', 'nothing downloaded or parsed'],
    first: ['Parse the JSON ✓', `Store content + ETag together`, `in ${e.device.cacheKey}`, 'Re-render from the new file'],
    updated: ['Parse the JSON ✓', 'Replace content + ETag together', d && `${d.added} added · ${d.changed} changed · ${d.removed} removed`, 'Re-render, changes highlighted'],
    'same-content': ['Parse the JSON ✓', 'New ETag, identical keys/values', '(whole site was redeployed)', 'Replace content + ETag together'],
    error: ['Keep the cached file or the', 'compiled base file on screen'],
  }[e.outcome];
  note('device', after, e.outcome === 'error' ? 'bad' : e.outcome === 'updated' ? 'warn' : 'plain');
  return steps;
}

/** Renders the steps as an SVG sequence diagram. */
export function flowSvg(e) {
  const steps = buildSteps(e);
  const lanes = { ...LANES, bff: { ...LANES.bff, sub: `${e.env.toUpperCase()} · /bff/${e.env}` } };
  const pop = (e.trace?.upstream?.headers?.['x-served-by'] ?? '').split(',').pop().trim();
  if (pop) lanes.cdn = { ...lanes.cdn, sub: `Fastly · ${pop}` };
  if (e.trace?.upstream?.url) lanes.origin = { ...lanes.origin, sub: new URL(e.trace.upstream.url).host };

  const parts = [];
  let y = 84;
  steps.forEach((s, i) => {
    const n = i + 1;
    if (s.type === 'note') {
      const lines = s.lines.flatMap(l => wrap(l));
      const x = lanes[s.lane].x - NOTE_W / 2;
      const h = lines.length * LINE + 12;
      parts.push(`<rect x="${x}" y="${y}" width="${NOTE_W}" height="${h}" rx="6" class="fl-note fl-note-${s.tone}"/>`);
      parts.push(text(x + 10, y + 16, lines, 'fl-text'));
      parts.push(badge(x - 2, y + 2, n));
      y += h + 12;
    } else {
      const x1 = lanes[s.from].x;
      const x2 = lanes[s.to].x;
      const dir = Math.sign(x2 - x1);
      const lines = s.lines.flatMap(l => wrap(l, 38));
      const mid = (x1 + x2) / 2;
      parts.push(text(mid, y + 11, lines, 'fl-text fl-label', 'middle'));
      const ay = y + lines.length * LINE + 6;
      parts.push(`<line x1="${x1 + dir * 4}" y1="${ay}" x2="${x2 - dir * 6}" y2="${ay}" class="fl-arrow fl-${s.tone}${s.dashed ? ' fl-dashed' : ''}" marker-end="url(#fl-ah-${s.tone})"/>`);
      parts.push(badge(x1 + dir * 14, ay, n));
      y = ay + 16;
    }
  });
  const height = y + 10;

  const heads = Object.values(lanes).map(l => `
    <rect x="${l.x - 110}" y="8" width="220" height="50" rx="8" class="fl-head"/>
    <text x="${l.x}" y="29" text-anchor="middle" class="fl-head-title">${esc(l.title)}</text>
    <text x="${l.x}" y="46" text-anchor="middle" class="fl-head-sub">${esc(l.sub)}</text>
    <line x1="${l.x}" y1="58" x2="${l.x}" y2="${height - 6}" class="fl-life"/>`).join('');

  const markers = ['req', 'ok', 'bad', 'plain', 'warn'].map(t => `
    <marker id="fl-ah-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="fl-mk-${t}"/>
    </marker>`).join('');

  const summary = `${steps.length} steps: ${e.env.toUpperCase()} ${e.tag}, ${e.status}`;
  return `<svg viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(summary)}" xmlns="http://www.w3.org/2000/svg">
    <defs>${markers}</defs>
    ${heads}
    ${parts.join('\n')}
  </svg>`;
}

function text(x, y, lines, cls, anchor = 'start') {
  const spans = lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : LINE}">${esc(l)}</tspan>`).join('');
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${spans}</text>`;
}

function badge(cx, cy, n) {
  return `<circle cx="${cx}" cy="${cy}" r="9" class="fl-badge"/><text x="${cx}" y="${cy + 3.5}" text-anchor="middle" class="fl-badge-text">${n}</text>`;
}
