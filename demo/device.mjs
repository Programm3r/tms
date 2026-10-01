// Simulates the RN shell on a device: render from cache (or the compiled base file), then
// revalidate in the background with one conditional GET to the BFF.
//
//   node demo/device.mjs --env sit --tag fr-CI [--key puk:section.request-puk] [--reset]
//
// The device cache lives in .device-cache/<env>/<tag>.json and holds the content and its ETag together.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_DIR = new URL('../i18n/', import.meta.url);   // stands in for the base files compiled into the app (D6)

export const baseTagFor = tag => (tag.startsWith('fr-') ? 'fr-FR' : 'en-US');

/** Resolves an i18next-style key, e.g. "puk:section.refresh" (journey = namespace). */
export function lookup(content, key) {
  const [ns, path] = key.includes(':') ? key.split(':') : ['puk', key];
  return path.split('.').reduce((o, k) => o?.[k], content?.[ns]);
}

/** One app launch for one language tag. Returns what happened, for printing. */
export async function launch({ bffUrl, tag, cacheDir, keys = [] }) {
  const cacheFile = join(cacheDir, `${tag}.json`);
  const cached = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : null;
  const baseTag = baseTagFor(tag);
  const base = JSON.parse(readFileSync(new URL(`${baseTag}.json`, BASE_DIR), 'utf8'));
  const renderedFrom = cached ? `device cache (ETag ${cached.etag})` : `compiled base file ${baseTag}`;

  const started = performance.now();
  let status = 'error';
  let bytes = 0;
  let etag = cached?.etag ?? null;
  let content = cached?.content ?? null;
  let outcome;
  try {
    const res = await fetch(`${bffUrl}/bootstrap/v1/localisation/${encodeURIComponent(tag)}`, {
      headers: cached ? { 'if-none-match': cached.etag } : {},
      signal: AbortSignal.timeout(2000),
    });
    const body = Buffer.from(await res.arrayBuffer());
    status = res.status;
    bytes = body.length;
    if (res.status === 304) {
      outcome = 'not modified: keep the cached file';
    } else if (res.status === 200) {
      const parsed = JSON.parse(body.toString('utf8'));   // must parse before it replaces anything
      etag = res.headers.get('etag');
      content = parsed;
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ etag, storedAt: new Date().toISOString(), content }, null, 2));
      outcome = cached ? 'changed: content and ETag replaced together' : 'stored in the device cache with its ETag';
    } else {
      outcome = `keep ${cached ? 'the cached file' : 'the compiled base file'} (BFF: ${body.toString('utf8')})`;
    }
  } catch (e) {
    outcome = `keep ${cached ? 'the cached file' : 'the compiled base file'} (BFF unreachable: ${e.message})`;
  }

  const active = content ?? base;
  const values = Object.fromEntries(keys.map(k => [k, lookup(active, k) ?? lookup(base, k) ?? k]));
  return { status, bytes, etag, outcome, renderedFrom, meta: content?._meta ?? null, values, ms: Math.round(performance.now() - started) };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const env = arg('--env', 'sit');
  const tag = arg('--tag', 'en-US');
  const key = arg('--key', 'puk:section.request-puk');
  const { loadConfig } = await import('../bff/bff.mjs');
  const e = loadConfig().environments[env];
  if (!e) {
    console.error(`Unknown environment "${env}"`);
    process.exit(2);
  }
  const cacheDir = join('.device-cache', env);
  if (process.argv.includes('--reset')) rmSync(cacheDir, { recursive: true, force: true });

  const r = await launch({ bffUrl: `http://localhost:${e.port}`, tag, cacheDir, keys: [key] });
  console.log(`launch ${env}/${tag}`);
  console.log(`  rendered first from : ${r.renderedFrom}`);
  const fresh = r.status === 200 || r.status === 304;
  console.log(`  BFF response        : ${r.status}, ${r.bytes} bytes, ${r.ms} ms${fresh && r.etag ? `, ETag ${r.etag}` : ''}`);
  console.log(`  result              : ${r.outcome}`);
  if (r.meta) console.log(`  _meta               : ${r.meta.tag} @ ${r.meta.commitId.slice(0, 7)} (${r.meta.publishedAt})`);
  console.log(`  ${key} = "${r.values[key]}"`);
}
