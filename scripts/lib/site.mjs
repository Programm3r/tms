// Helpers for talking to the live GitHub Pages site.
import { appendFileSync } from 'node:fs';

/** Fetches a URL; a cache-busting query makes GitHub's CDN go back to its origin. */
export async function get(url, { bust = false, headers = {} } = {}) {
  const u = new URL(url);
  if (bust) u.searchParams.set('nocache', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return fetch(u, { headers: { 'accept-encoding': 'identity', ...headers }, signal: AbortSignal.timeout(15_000) });
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
