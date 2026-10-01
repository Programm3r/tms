// Bootstrap BFF – option B: a pure pass-through to GitHub Pages.
//
//   GET /bootstrap/v1/localisation/{tag}
//
// - The tag must be on this environment's allowlist (400 otherwise, with no upstream call).
// - One upstream GET to {baseUrl}{tag}.json with Accept-Encoding: identity (GitHub Pages gives the
//   gzip variant a different ETag) and the device's If-None-Match forwarded unchanged.
// - GitHub's CDN answers the conditional request itself, so 304 and 200 are passed straight through
//   with the origin ETag. The BFF never computes or compares ETags and stores nothing.
// - 404 becomes the BFF's own JSON error (GitHub's HTML 404 page and its ETag are not forwarded).
// - Upstream errors become 502, timeouts 504. Partial content is never returned.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const CACHE_CONTROL = 'public, max-age=300, must-revalidate';
const ROUTE = /^\/bootstrap\/v1\/localisation\/([^/]+)$/;

export function loadConfig(path = new URL('./config.json', import.meta.url)) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const siteUrl = (process.env.I18N_SITE_URL ?? config.siteUrl).replace(/\/$/, '');
  for (const [env, e] of Object.entries(config.environments)) {
    e.env = env;
    e.baseUrl ??= `${siteUrl}/${env}/i18n/v1/`;
    e.timeoutMs ??= config.timeoutMs;
  }
  return { ...config, siteUrl };
}

export function createBff(options) {
  return createServer(createBffHandler(options));
}

/**
 * The request handler on its own, so the demo app server can host every environment's BFF.
 * trace: true adds an x-trace response header describing what the BFF did (demo app only).
 */
export function createBffHandler({ env, baseUrl, tags, timeoutMs = 2000, log = console.log, trace = false }) {
  const allowlist = new Set(tags);

  return async (req, res) => {
    const started = performance.now();
    const path = new URL(req.url, 'http://bff').pathname;
    const match = ROUTE.exec(path);
    const inm = req.headers['if-none-match'];
    const steps = { env, allowlisted: null, upstream: null };
    const done = (status, headers, body, upstream = '') => {
      const ms = Math.round(performance.now() - started);
      const traceHeader = trace ? { 'x-trace': encodeURIComponent(JSON.stringify({ ...steps, status, bffMs: ms })) } : {};
      res.writeHead(status, { 'x-bff-env': env, ...headers, ...traceHeader });
      res.end(req.method === 'HEAD' ? undefined : body);
      log(`[${env}] ${req.method} ${path}${inm ? ` If-None-Match: ${inm}` : ''} ${upstream}→ ${status} (${ms} ms)`);
    };
    const error = (status, code, extra = {}, upstream) =>
      done(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify({ error: code, ...extra }), upstream);

    if (req.method !== 'GET' && req.method !== 'HEAD') return error(405, 'method_not_allowed');
    if (!match) return error(404, 'not_found');
    const tag = decodeURIComponent(match[1]);
    steps.allowlisted = allowlist.has(tag);
    if (!steps.allowlisted) return error(400, 'unsupported_tag', { tag });

    const url = new URL(`${tag}.json`, baseUrl);
    const requestHeaders = { 'accept-encoding': 'identity', ...(inm ? { 'if-none-match': inm } : {}) };
    const upstreamStarted = performance.now();
    steps.upstream = { url: url.href, request: requestHeaders };
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

    if (upstream.status === 304) {
      steps.upstream.bytes = 0;
      steps.upstream.ms = Math.round(performance.now() - upstreamStarted);
      return done(304, { ...(etag ? { etag } : {}), ...passThrough }, undefined, via);
    }
    if (upstream.status === 200) {
      let body;
      try {
        body = Buffer.from(await upstream.arrayBuffer());
      } catch (e) {
        steps.upstream.error = e.name;
        return error(e.name === 'TimeoutError' ? 504 : 502, 'upstream_incomplete', {}, via);
      }
      steps.upstream.bytes = body.length;
      steps.upstream.ms = Math.round(performance.now() - upstreamStarted);
      return done(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        ...(etag ? { etag } : {}),
        ...passThrough,
      }, body, via);
    }
    await upstream.body?.cancel();
    steps.upstream.ms = Math.round(performance.now() - upstreamStarted);
    if (upstream.status === 404) return error(404, 'locale_not_published', { tag }, via);
    return error(502, 'upstream_error', { status: upstream.status }, via);
  };
}
