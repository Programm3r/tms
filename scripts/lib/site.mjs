// Helpers for talking to the live GitHub Pages site.
import { appendFileSync } from 'node:fs';

/**
 * Returns a variant of a GitHub Pages URL that GitHub's CDN has (almost certainly) not cached yet.
 *
 * GitHub's CDN ignores query strings and request headers such as Cache-Control: no-cache, so neither
 * forces a fresh copy. It does treat extra slashes in the path as a separate cache entry, and the
 * Pages origin ignores them: /tms/sit///i18n/v1//fr-CI.json is a cache MISS for the same file and
 * ETag. Each variant is cached once used, so the slash counts are random (1–20 per separator).
 * Undocumented GitHub behaviour: use for tooling and the demo only, never in the real BFF.
 */
export function cdnBypassUrl(url) {
  const u = new URL(url);
  const segments = u.pathname.split('/').filter(Boolean);
  u.pathname = segments.map((s, i) => (i === 0 ? '/' : '/'.repeat(1 + Math.floor(Math.random() * 20))) + s).join('');
  return u.href;
}

/** Fetches a URL; bust: true asks GitHub's CDN for an uncached path variant, so the origin answers. */
export async function get(url, { bust = false, headers = {} } = {}) {
  return fetch(bust ? cdnBypassUrl(url) : url, { headers: { 'accept-encoding': 'identity', ...headers }, signal: AbortSignal.timeout(15_000) });
}

export async function getJson(url) {
  const res = await get(url, { bust: true });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** GitHub Pages ETags look like "<hex mtime>-<hex size>"; W/ marks the gzip variant. */
export function decodeEtag(etag) {
  const m = /^(W\/)?"([0-9a-f]+)-([0-9a-f]+)"$/.exec(etag ?? '');
  if (!m) return null;
  return {
    weak: Boolean(m[1]),
    mtime: new Date(parseInt(m[2], 16) * 1000).toISOString().replace('.000Z', 'Z'),
    size: parseInt(m[3], 16),
  };
}

export function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  else console.log(markdown);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
