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

export function createBff({ env, baseUrl, tags, timeoutMs = 2000, log = console.log }) {
  const allowlist = new Set(tags);

  return createServer(async (req, res) => {
    const started = performance.now();
    const path = new URL(req.url, 'http://bff').pathname;
    const match = ROUTE.exec(path);
    const inm = req.headers['if-none-match'];
    const done = (status, headers, body, upstream = '') => {
      res.writeHead(status, { 'x-bff-env': env, ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
      const ms = Math.round(performance.now() - started);
      log(`[${env}] ${req.method} ${path}${inm ? ` If-None-Match: ${inm}` : ''} ${upstream}→ ${status} (${ms} ms)`);
    };
    const error = (status, code, extra = {}, upstream) =>
      done(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify({ error: code, ...extra }), upstream);

    if (req.method !== 'GET' && req.method !== 'HEAD') return error(405, 'method_not_allowed');
    if (!match) return error(404, 'not_found');
    const tag = decodeURIComponent(match[1]);
    if (!allowlist.has(tag)) return error(400, 'unsupported_tag', { tag });

    let upstream;
    try {
      upstream = await fetch(new URL(`${tag}.json`, baseUrl), {
        headers: { 'accept-encoding': 'identity', ...(inm ? { 'if-none-match': inm } : {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e.name === 'TimeoutError';
      return error(timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_unreachable', {}, `upstream ${e.name} `);
    }

    const etag = upstream.headers.get('etag');
    const via = `upstream ${upstream.status}${upstream.headers.get('x-cache') ? ` (CDN ${upstream.headers.get('x-cache')})` : ''} `;
    const passThrough = {
      'cache-control': CACHE_CONTROL,
      'x-upstream-status': String(upstream.status),
      ...(upstream.headers.get('x-cache') ? { 'x-upstream-cache': upstream.headers.get('x-cache') } : {}),
    };

    if (upstream.status === 304) {
      return done(304, { ...(etag ? { etag } : {}), ...passThrough }, undefined, via);
    }
    if (upstream.status === 200) {
      let body;
      try {
        body = Buffer.from(await upstream.arrayBuffer());
      } catch (e) {
        return error(e.name === 'TimeoutError' ? 504 : 502, 'upstream_incomplete', {}, via);
      }
      return done(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        ...(etag ? { etag } : {}),
        ...passThrough,
      }, body, via);
    }
    await upstream.body?.cancel();
    if (upstream.status === 404) return error(404, 'locale_not_published', { tag }, via);
    return error(502, 'upstream_error', { status: upstream.status }, via);
  });
}
