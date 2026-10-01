// Animated data flow for one launch. Four blocks (device, BFF, GitHub CDN edge, GitHub Pages origin);
// each request or response travels between them as a labelled packet, and the block that acts lights
// up and shows what it did. Requests travel over the top, responses come back underneath.
// Built from the call's real values: the device's own bookkeeping plus the BFF's x-trace header.

const BLOCKS = ['device', 'bff', 'cdn', 'origin'];
const NAMES = { device: 'Device app', bff: 'Bootstrap BFF', cdn: 'GitHub CDN edge', origin: 'GitHub Pages origin' };
const ICONS = {
  device: '<svg viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="10" y1="18.5" x2="14" y2="18.5"/></svg>',
  bff: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><circle cx="7" cy="6.5" r="1"/><circle cx="7" cy="17.5" r="1"/></svg>',
  cdn: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>',
  origin: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
};
const STATUS = { 200: '200 OK', 304: '304 Not Modified', 400: '400 Bad Request', 404: '404 Not Found', 502: '502 Bad Gateway', 504: '504 Gateway Timeout' };
const statusLine = s => STATUS[s] ?? String(s);
const short = sha => (sha ? sha.slice(0, 7) : '—');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Turns one history entry into steps:
 *   { type: 'note', at, lines, tone }               a block does something
 *   { type: 'msg', from, to, pill, lines, tone }    a request or response travels
 */
export function buildSteps(e) {
  const steps = [];
  const note = (at, lines, tone = 'plain') => steps.push({ type: 'note', at, lines: lines.filter(Boolean), tone });
  const msg = (from, to, pill, lines, tone) => steps.push({ type: 'msg', from, to, pill, lines: lines.filter(Boolean), tone });
  const ENV = e.env.toUpperCase();
  const etagShort = etag => (etag && etag.length > 16 ? `${etag.slice(0, 13)}…"` : etag);

  note('device', e.device.cached
    ? ['App launch: read the device cache', `${e.device.cacheKey} → ETag ${e.device.cached.etag}`, `(commit ${short(e.device.cached.commit)})`, 'Render the screen from the cache']
    : ['App launch: read the device cache', `${e.device.cacheKey} → empty`, `Render from the compiled base file ${e.device.base}`]);
  msg('device', 'bff',
    e.sent ? `GET ${e.tag} · If-None-Match ${etagShort(e.sent)}` : `GET ${e.tag} · no ETag`,
    [`GET /bootstrap/v1/localisation/${e.tag}`, e.sent ? `If-None-Match: ${e.sent}` : 'No If-None-Match: nothing is cached yet'], 'req');

  if (e.status === 'network') {
    note('device', ['The BFF did not answer', e.error, 'Keep what is on screen'], 'bad');
    return steps;
  }
  const t = e.trace;
  if (!t) {
    msg('bff', 'device', statusLine(e.status), [statusLine(e.status)], e.status < 400 ? 'ok' : 'bad');
    return steps;
  }

  if (t.allowlisted === false) {
    note('bff', [`${e.tag} is not on the ${ENV} allowlist`, 'Reject. GitHub is not called.'], 'bad');
    msg('bff', 'device', '400 unsupported_tag', ['400 Bad Request', '{"error":"unsupported_tag"}', 'No ETag'], 'bad');
    note('device', ['Keep the cached file, or the', 'compiled base file, on screen'], 'bad');
    return steps;
  }

  note('bff', [
    `${e.tag} is on the ${ENV} allowlist ✓`,
    'Build the upstream request:',
    'Accept-Encoding: identity (forced)',
    e.sent ? 'If-None-Match: forwarded unchanged' : 'If-None-Match: none to forward',
    t.upstream?.bypass && 'Demo: bypass the GitHub CDN with an uncached path variant (extra slashes)',
  ]);

  const u = t.upstream;
  const path = new URL(u.url).pathname;
  const file = path.split('/').pop();
  msg('bff', 'cdn',
    u.request['if-none-match'] ? `GET ${file} · If-None-Match ${etagShort(u.request['if-none-match'])}` : `GET ${file}`,
    [`GET ${u.url}`, 'Accept-Encoding: identity', u.request['if-none-match'] && `If-None-Match: ${u.request['if-none-match']}`], 'req');

  if (u.error) {
    note('bff', [`GitHub did not answer (${u.error})`, `after ${u.ms} ms`], 'bad');
    msg('bff', 'device', statusLine(e.status), [statusLine(e.status), 'JSON error, no ETag'], 'bad');
    note('device', ['Keep the cached file, or the', 'compiled base file, on screen'], 'bad');
    return steps;
  }

  const h = u.headers ?? {};
  const xCache = h['x-cache'] ?? '';
  const pop = (h['x-served-by'] ?? '').split(',').pop().trim();
  if (/HIT/.test(xCache)) {
    note('cdn', [
      `Cache HIT at ${pop || 'the edge'}`,
      `Copy is ${h.age ?? '?'} s old (max-age 600 s)`,
      u.status === 304 ? 'If-None-Match equals its ETag → 304' : 'Serve the cached copy → 200',
      'The origin is not contacted',
    ]);
  } else {
    note('cdn', [`Cache ${xCache || 'MISS'} at ${pop || 'the edge'}`, u.bypass && 'This path variant is not cached yet', 'Fetch the file from the origin']);
    msg('cdn', 'origin', `GET ${file}`, [`GET ${path}`], 'req');
    note('origin', [`${file} in the deployed site`, u.bypass && 'Extra slashes ignored: same file', h['last-modified'] && `Last-Modified ${h['last-modified']}`, 'ETag = "<file time hex>-<size hex>"']);
    msg('origin', 'cdn', `file · ETag ${etagShort(h.etag)}`, ['File and ETag', h.etag], 'plain');
    note('cdn', ['Store the copy at the edge', u.status === 304 ? 'If-None-Match equals the ETag → 304' : 'Answer 200 with the file']);
  }

  const ok = u.status === 200 || u.status === 304;
  msg('cdn', 'bff',
    u.status === 200 ? `200 · ${u.bytes} B · ETag ${etagShort(h.etag)}` : u.status === 304 ? `304 · 0 B · ETag ${etagShort(h.etag)}` : `${u.status} · HTML page`,
    [statusLine(u.status), h.etag && `ETag: ${h.etag}`, u.status === 200 ? `${u.bytes} bytes · Cache-Control: ${h['cache-control'] ?? '—'}` : u.status === 304 ? '0 bytes' : 'GitHub\'s HTML error page', `${u.ms} ms`],
    ok ? 'ok' : 'bad');

  if (ok) note('bff', ['Pass through unchanged', 'status, ETag and body as received', 'Cache-Control: max-age=300', 'Nothing is stored']);
  else if (u.status === 404) note('bff', ['GitHub\'s 404 is an HTML page', 'with its own ETag: drop both,', 'answer with the BFF\'s JSON 404'], 'bad');
  else note('bff', [`Unexpected upstream ${u.status}`, 'Answer 502, never partial content'], 'bad');

  msg('bff', 'device',
    e.status === 200 ? `200 · ${e.bytes} B · ETag ${etagShort(e.received)}` : e.status === 304 ? `304 · 0 B · ETag ${etagShort(e.received)}` : statusLine(e.status),
    [statusLine(e.status), e.received ? `ETag: ${e.received}` : 'No ETag', `${e.bytes} bytes · ${e.ms} ms in total (BFF ${t.bffMs} ms)`],
    e.status === 200 || e.status === 304 ? 'ok' : 'bad');

  const d = e.diff;
  note('device', {
    unchanged: ['304: keep the cached file', 'Nothing downloaded or parsed'],
    first: ['Parse the JSON ✓', 'Store content + ETag together', `in ${e.device.cacheKey}`, 'Re-render from the new file'],
    updated: ['Parse the JSON ✓', 'Replace content + ETag together', d && `${d.added} added · ${d.changed} changed · ${d.removed} removed`, 'Re-render; changes are highlighted'],
    'same-content': ['Parse the JSON ✓', 'New ETag but identical keys and values', '(the whole site was redeployed)', 'Replace content + ETag together'],
    error: ['Keep the cached file, or the', 'compiled base file, on screen'],
  }[e.outcome], e.outcome === 'error' ? 'bad' : e.outcome === 'updated' ? 'warn' : 'ok');
  return steps;
}

export class FlowPlayer {
  constructor(root) {
    this.root = root;
    this.speed = 1;
    this.paused = false;
    this.runId = 0;
    this.index = -1;
    this.steps = [];
    this.entry = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    root.innerHTML = `
      <div class="fp-controls">
        <button type="button" data-act="replay">↺ Replay</button>
        <button type="button" data-act="toggle" class="fp-toggle">Pause</button>
        <button type="button" data-act="prev" aria-label="Previous step">◀</button>
        <button type="button" data-act="next" aria-label="Next step">▶</button>
        <label>Speed
          <select data-act="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>
        </label>
        <span class="fp-progress muted"></span>
      </div>
      <div class="fp-scroll">
        <div class="fp-stage">
          <svg class="fp-wires" aria-hidden="true"></svg>
          ${BLOCKS.map(b => `
            <div class="fp-block" data-b="${b}">
              <div class="fp-icon">${ICONS[b]}</div>
              <div class="fp-title">${NAMES[b]}</div>
              <div class="fp-sub"></div>
              <div class="fp-state"></div>
            </div>`).join('')}
          <div class="fp-packet" hidden><span class="fp-dot"></span><span class="fp-txt"></span></div>
        </div>
      </div>
      <div class="fp-now" aria-live="polite"></div>`;

    this.stage = root.querySelector('.fp-stage');
    this.wires = root.querySelector('.fp-wires');
    this.packet = root.querySelector('.fp-packet');
    this.blocks = Object.fromEntries(BLOCKS.map(b => [b, root.querySelector(`[data-b="${b}"]`)]));

    root.querySelector('.fp-controls').addEventListener('click', ev => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'replay') this.play(0);
      if (act === 'toggle') this.toggle();
      if (act === 'prev') this.jump(Math.max(0, this.index - 1));
      if (act === 'next') this.jump(Math.min(this.steps.length - 1, this.index + 1));
    });
    root.querySelector('[data-act="speed"]').addEventListener('change', ev => {
      this.speed = Number(ev.target.value);
      if (this.anim) this.anim.playbackRate = this.speed;
    });
    new ResizeObserver(() => this.layout()).observe(this.stage);
  }

  /** Shows a new call: resets the stage and plays it from the start. */
  load(entry) {
    this.entry = entry;
    this.steps = buildSteps(entry);
    const pop = (entry.trace?.upstream?.headers?.['x-served-by'] ?? '').split(',').pop().trim();
    const host = entry.trace?.upstream?.url ? new URL(entry.trace.upstream.url).host : 'github.io';
    this.subs = {
      device: 'browser · localStorage cache',
      bff: `${entry.env.toUpperCase()} · /bff/${entry.env}`,
      cdn: pop ? `Fastly · ${pop}` : 'Fastly',
      origin: host,
    };
    const involved = new Set(this.steps.flatMap(s => (s.type === 'note' ? [s.at] : [s.from, s.to])));
    for (const b of BLOCKS) {
      this.blocks[b].querySelector('.fp-sub').textContent = this.subs[b];
      this.blocks[b].classList.toggle('idle', !involved.has(b));
    }
    this.layout();
    if (this.reduced) this.jump(this.steps.length - 1);
    else this.play(0);
  }

  async play(from) {
    const id = ++this.runId;
    this.paused = false;
    this.updateToggle();
    this.applyStates(from - 1);
    for (let i = from; i < this.steps.length; i++) {
      if (id !== this.runId) return;
      await this.show(i, id);
      await this.wait(150, id);
    }
    if (id === this.runId) this.finish();
  }

  toggle() {
    if (this.index >= this.steps.length - 1 && !this.anim && this.done) return this.play(0);
    this.paused = !this.paused;
    if (this.anim) this.paused ? this.anim.pause() : this.anim.play();
    this.updateToggle();
  }

  /** Stops playback and shows step i with everything before it already applied. */
  jump(i) {
    this.runId++;
    this.paused = true;
    this.updateToggle();
    this.anim?.cancel();
    this.anim = null;
    this.applyStates(i - 1);
    this.show(i, this.runId, false);
  }

  async show(i, id, animate = true) {
    const s = this.steps[i];
    this.index = i;
    this.done = false;
    this.markTimeline(i);
    this.setNow(i);
    this.clearActive();

    if (s.type === 'note') {
      this.packet.hidden = true;
      this.setState(s.at, s.lines, s.tone);
      this.blocks[s.at].classList.add('focus');
      if (animate) await this.wait(500 + 150 * s.lines.length, id);
      return;
    }

    const wire = this.wires.querySelector(`[data-w="${s.from}-${s.to}"]`);
    wire?.classList.add('active', `t-${s.tone}`);
    this.blocks[s.from].classList.add('sending');
    this.packet.className = `fp-packet t-${s.tone}`;
    this.packet.querySelector('.fp-txt').textContent = s.pill;
    this.packet.hidden = false;
    this.packet.style.offsetPath = `path('${this.paths[`${s.from}-${s.to}`]}')`;
    if (!animate) {
      this.packet.style.offsetDistance = '100%';
      this.blocks[s.to].classList.add('focus');
      return;
    }
    this.anim = this.packet.animate([{ offsetDistance: '0%' }, { offsetDistance: '100%' }], { duration: 1000, easing: 'ease-in-out', fill: 'forwards' });
    this.anim.playbackRate = this.speed;
    if (this.paused) this.anim.pause();
    try {
      await this.anim.finished;
    } catch {
      return;   // cancelled by a jump or a new call
    }
    this.anim = null;
    if (id !== this.runId) return;
    this.blocks[s.to].classList.add('focus', 'receive');
    setTimeout(() => this.blocks[s.to].classList.remove('receive'), 600);
  }

  finish() {
    this.done = true;
    this.clearActive();
    this.packet.hidden = true;
    const last = this.steps.at(-1);
    if (last?.type === 'note') this.blocks[last.at].classList.add('focus');
    this.markTimeline(this.steps.length);
    this.root.querySelector('.fp-progress').textContent = 'Done. Replay or step through.';
    this.paused = true;
    this.updateToggle(true);
  }

  // ---------- state ----------
  applyStates(upTo) {
    for (const b of BLOCKS) {
      const block = this.blocks[b];
      block.classList.remove('focus', 'sending', 'receive', 't-bad', 't-warn', 't-ok');
      block.querySelector('.fp-state').innerHTML = block.classList.contains('idle') ? '<span class="muted">not contacted for this call</span>' : '';
    }
    for (let k = 0; k <= upTo; k++) {
      const s = this.steps[k];
      if (s.type === 'note') this.setState(s.at, s.lines, s.tone);
    }
    this.packet.hidden = true;
    this.clearActive();
  }

  setState(b, lines, tone) {
    const block = this.blocks[b];
    block.classList.remove('t-bad', 't-warn', 't-ok');
    if (tone !== 'plain') block.classList.add(`t-${tone}`);
    block.querySelector('.fp-state').innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join('');
  }

  clearActive() {
    for (const b of BLOCKS) this.blocks[b].classList.remove('focus', 'sending');
    this.wires.querySelectorAll('.active').forEach(w => w.classList.remove('active', 't-req', 't-ok', 't-bad', 't-plain', 't-warn'));
  }

  markTimeline(i) {
    this.root.querySelector('.fp-progress').textContent = i < this.steps.length ? `Step ${i + 1} of ${this.steps.length}` : '';
  }

  setNow(i) {
    const s = this.steps[i];
    const head = s.type === 'msg' ? `${NAMES[s.from]} → ${NAMES[s.to]}` : NAMES[s.at];
    this.root.querySelector('.fp-now').innerHTML = `
      <span class="fp-n fp-${s.tone}">${i + 1}</span>
      <div><strong>${esc(head)}</strong>${s.lines.map(l => `<div class="mono">${esc(l)}</div>`).join('')}</div>`;
  }

  updateToggle(finished = false) {
    this.root.querySelector('.fp-toggle').textContent = finished ? 'Play' : this.paused ? 'Resume' : 'Pause';
  }

  wait(ms, id) {
    return new Promise(async resolve => {
      let left = ms / this.speed;
      while (left > 0) {
        if (id !== this.runId) return resolve();
        await sleep(50);
        if (!this.paused) left -= 50;
      }
      resolve();
    });
  }

  // ---------- geometry: wires over the top (requests) and underneath (responses) ----------
  layout() {
    const box = this.stage.getBoundingClientRect();
    if (!box.width) return;
    const r = Object.fromEntries(BLOCKS.map(b => {
      const k = this.blocks[b].getBoundingClientRect();
      return [b, { cx: k.left - box.left + k.width / 2, top: k.top - box.top, bottom: k.bottom - box.top }];
    }));
    const yTop = Math.min(...BLOCKS.map(b => r[b].top)) - 26;
    const yBottom = Math.max(...BLOCKS.map(b => r[b].bottom)) + 26;
    this.paths = {};
    const wires = [];
    for (let i = 0; i < BLOCKS.length - 1; i++) {
      const a = BLOCKS[i];
      const b = BLOCKS[i + 1];
      const req = `M ${r[a].cx + 18} ${r[a].top} L ${r[a].cx + 18} ${yTop} L ${r[b].cx - 18} ${yTop} L ${r[b].cx - 18} ${r[b].top}`;
      const res = `M ${r[b].cx - 18} ${r[b].bottom} L ${r[b].cx - 18} ${yBottom} L ${r[a].cx + 18} ${yBottom} L ${r[a].cx + 18} ${r[a].bottom}`;
      this.paths[`${a}-${b}`] = req;
      this.paths[`${b}-${a}`] = res;
      wires.push(`<path d="${req}" data-w="${a}-${b}" class="fp-wire" marker-end="url(#fp-arrow)"/>`);
      wires.push(`<path d="${res}" data-w="${b}-${a}" class="fp-wire" marker-end="url(#fp-arrow)"/>`);
    }
    this.wires.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    this.wires.innerHTML = `
      <defs><marker id="fp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" class="fp-arrowhead"/></marker></defs>
      ${wires.join('')}`;
    if (this.packet && !this.packet.hidden && this.index >= 0 && this.steps[this.index]?.type === 'msg') {
      const s = this.steps[this.index];
      this.packet.style.offsetPath = `path('${this.paths[`${s.from}-${s.to}`]}')`;
    }
    if (this.index >= 0 && this.steps[this.index]?.type === 'msg') {
      const s = this.steps[this.index];
      this.wires.querySelector(`[data-w="${s.from}-${s.to}"]`)?.classList.add('active', `t-${s.tone}`);
    }
  }
}
