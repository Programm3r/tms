// Bootstrap BFF – option B: BFF → GitHub Pages directly, no Front Door.
//
//   GET /bootstrap/v1/localisation/{tag}
//
// - The tag must be on this environment's allowlist (400 otherwise, with no upstream call).
// - One upstream GET to {baseUrl}{tag}.json with Accept-Encoding: identity (GitHub Pages gives the
//   gzip variant a different ETag).
// - 404 becomes the BFF's own JSON error (GitHub's HTML 404 page and its ETag are not forwarded).
// - Upstream errors become 502, timeouts 504. Partial content is never returned.
//
// Two ETag modes (etagMode in config.json, per environment):
//   github   (default) Pure pass-through. The device's If-None-Match is forwarded unchanged, GitHub's
//            CDN answers it, and 304 or 200 is passed back with GitHub's ETag. The BFF computes and
//            stores nothing. GitHub's ETag is "<file time>-<size>", and every Pages deploy sets new
//            file times, so any publish (even SIT-only) makes every device download its file again.
//   content  The ETag the device sees is a hash of the file's bytes, so it changes only when the
//            file does. The BFF keeps, per tag, GitHub's ETag, the hash and the body (a few KB), asks
//            GitHub conditionally with its own stored ETag, and compares the device's If-None-Match
//            with the hash itself. Losing that memory only costs one full fetch from GitHub.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { cdnBypassUrl } from '../scripts/lib/site.mjs';

const CACHE_CONTROL = 'public, max-age=300, must-revalidate';
const ROUTE = /^\/bootstrap\/v1\/localisation\/([^/]+)$/;
export const ETAG_MODES = ['github', 'content'];

/** Content mode's ETag: the first 128 bits of the file's SHA-256, as a strong ETag. */
export const contentEtag = body => `"sha256-${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;

/** If-None-Match is "*" or a list of ETags, compared weakly (RFC 9110 §13.1.2). */
function ifNoneMatchHits(inm, etag) {
  if (!inm || !etag) return false;
  const opaque = t => t.trim().replace(/^W\//, '');
  return inm.split(',').some(t => t.trim() === '*' || opaque(t) === opaque(etag));
}

export function loadConfig(path = new URL('./config.json', import.meta.url)) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const siteUrl = (process.env.I18N_SITE_URL ?? config.siteUrl).replace(/\/$/, '');
  for (const [env, e] of Object.entries(config.environments)) {
    e.env = env;
    e.baseUrl ??= `${siteUrl}/${env}/i18n/v1/`;
    e.timeoutMs ??= config.timeoutMs;
    e.etagMode ??= config.etagMode ?? 'github';
  }
  return { ...config, siteUrl };
}

export function createBff(options) {
  return createServer(createBffHandler(options));
}

/**
 * The request handler on its own, so the demo app server can host every environment's BFF.
 * Demo app only:
 *   trace: true                  adds an x-trace response header describing what the BFF did
 *   allowCdnBypass: true         honours "x-demo-bypass-cdn: 1" by requesting an uncached path variant,
 *                                so GitHub's CDN misses and the origin answers (never in the real BFF)
 *   allowEtagModeOverride: true  honours "x-demo-etag-mode: github|content", so the demo can show
 *                                both modes side by side
 */
export function createBffHandler({
  env, baseUrl, tags, timeoutMs = 2000, etagMode = 'github',
  log = console.log, trace = false, allowCdnBypass = false, allowEtagModeOverride = false,
}) {
  if (!ETAG_MODES.includes(etagMode)) throw new Error(`${env}: unknown etagMode "${etagMode}" (expected ${ETAG_MODES.join(' or ')})`);
  const allowlist = new Set(tags);
  const stored = new Map();   // content mode only: tag → { upstreamEtag, etag, body }

  return async (req, res) => {
    const started = performance.now();
    const path = new URL(req.url, 'http://bff').pathname;
    const match = ROUTE.exec(path);
    const inm = req.headers['if-none-match'];
    const requestedMode = req.headers['x-demo-etag-mode'];
    const mode = allowEtagModeOverride && ETAG_MODES.includes(requestedMode) ? requestedMode : etagMode;
    const steps = { env, mode, allowlisted: null, upstream: null };
    const done = (status, headers, body, upstream = '') => {
      const ms = Math.round(performance.now() - started);
      const traceHeader = trace ? { 'x-trace': encodeURIComponent(JSON.stringify({ ...steps, status, bffMs: ms })) } : {};
      res.writeHead(status, { 'x-bff-env': env, 'x-bff-etag-mode': mode, ...headers, ...traceHeader });
      res.end(req.method === 'HEAD' ? undefined : body);
      log(`[${env}${mode === 'content' ? ' · content ETag' : ''}] ${req.method} ${path}${inm ? ` If-None-Match: ${inm}` : ''} ${upstream}→ ${status} (${ms} ms)`);
    };
    const error = (status, code, extra = {}, upstream) =>
      done(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify({ error: code, ...extra }), upstream);

    if (req.method !== 'GET' && req.method !== 'HEAD') return error(405, 'method_not_allowed');
    if (!match) return error(404, 'not_found');
    const tag = decodeURIComponent(match[1]);
    steps.allowlisted = allowlist.has(tag);
    if (!steps.allowlisted) return error(400, 'unsupported_tag', { tag });

    // github: forward the device's If-None-Match. content: the device holds a hash GitHub has never
    // seen, so ask with the GitHub ETag the BFF stored last time instead.
    const previous = mode === 'content' ? stored.get(tag) : undefined;
    const upstreamInm = mode === 'content' ? previous?.upstreamEtag : inm;
    const bypass = allowCdnBypass && req.headers['x-demo-bypass-cdn'] === '1';
    const url = new URL(bypass ? cdnBypassUrl(new URL(`${tag}.json`, baseUrl).href) : new URL(`${tag}.json`, baseUrl));
    const requestHeaders = { 'accept-encoding': 'identity', ...(upstreamInm ? { 'if-none-match': upstreamInm } : {}) };
    const upstreamStarted = performance.now();
    steps.upstream = { url: url.href, request: requestHeaders, bypass };
    let upstream;
    try {
      upstream = await fetch(url, { headers: requestHeaders, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = e.name === 'TimeoutError';
      steps.upstream.error = e.name;
      steps.upstream.ms = Math.round(performance.now() - upstreamStarted);
      return error(timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_unreachable', {}, `upstream ${e.name} `);
    }

    const etag = upstream.headers.get('etag');
    const h = name => upstream.headers.get(name) ?? undefined;
    steps.upstream.status = upstream.status;
    steps.upstream.headers = {
      etag: h('etag'), 'cache-control': h('cache-control'), 'last-modified': h('last-modified'), 'content-encoding': h('content-encoding'),
      'x-cache': h('x-cache'), 'x-cache-hits': h('x-cache-hits'), 'x-served-by': h('x-served-by'), age: h('age'), 'x-proxy-cache': h('x-proxy-cache'),
    };
    const via = `upstream ${upstream.status}${upstream.headers.get('x-cache') ? ` (CDN ${upstream.headers.get('x-cache')})` : ''} `;
    const passThrough = {
      'cache-control': CACHE_CONTROL,
      'x-upstream-status': String(upstream.status),
      ...(upstream.headers.get('x-cache') ? { 'x-upstream-cache': upstream.headers.get('x-cache') } : {}),
    };
    const json = body => ({ 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });

    if (upstream.status === 200 || upstream.status === 304) {
      let body;
      if (upstream.status === 200) {
        try {
          body = Buffer.from(await upstream.arrayBuffer());
        } catch (e) {
          steps.upstream.error = e.name;
          return error(e.name === 'TimeoutError' ? 504 : 502, 'upstream_incomplete', {}, via);
        }
      }
      steps.upstream.bytes = body?.length ?? 0;
      steps.upstream.ms = Math.round(performance.now() - upstreamStarted);

      if (mode === 'github') {
        if (upstream.status === 304) return done(304, { ...(etag ? { etag } : {}), ...passThrough }, undefined, via);
        return done(200, { ...json(body), ...(etag ? { etag } : {}), ...passThrough }, body, via);
      }

      // content: 200 → hash the new body and store it; 304 → GitHub says the stored body is current.
      let current = previous;
      if (upstream.status === 200) {
        current = { upstreamEtag: etag, etag: contentEtag(body), body };
        if (etag) stored.set(tag, current);
        else stored.delete(tag);   // nothing to revalidate with next time
      } else if (!previous) {
        return error(502, 'upstream_error', { status: 304 }, via);   // a 304 to a request without If-None-Match
      }
      const hit = ifNoneMatchHits(inm, current.etag);
      steps.content = {
        stored: previous ? { upstreamEtag: previous.upstreamEtag, etag: previous.etag } : null,
        upstreamEtag: current.upstreamEtag ?? null,
        etag: current.etag,
        hashed: upstream.status === 200,
        match: hit,
      };
      const headers = { etag: current.etag, ...(current.upstreamEtag ? { 'x-upstream-etag': current.upstreamEtag } : {}), ...passThrough };
      if (hit) return done(304, headers, undefined, via);
      return done(200, { ...json(current.body), ...headers }, current.body, via);
    }
    await upstream.body?.cancel();
    steps.upstream.ms = Math.round(performance.now() - upstreamStarted);
    if (upstream.status === 404) {
      stored.delete(tag);
      return error(404, 'locale_not_published', { tag }, via);
    }
    return error(502, 'upstream_error', { status: upstream.status }, via);
  };
}
