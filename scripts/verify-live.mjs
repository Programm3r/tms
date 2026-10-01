// Runs after deploy: waits until every environment serves the commit that was built, then shows
// the option B behaviour for each published file in the job summary.
//
// Usage: node scripts/verify-live.mjs --site <pages base url> --heads '{"sit":"<sha>",...}' [--timeout 600]
import { decodeEtag, get, getJson, sleep, summary } from './lib/site.mjs';

const opt = { timeout: '600' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
const site = opt.site.replace(/\/$/, '');
const heads = JSON.parse(opt.heads);
const deadline = Date.now() + Number(opt.timeout) * 1000;

const live = {};
for (const [env, sha] of Object.entries(heads)) {
  for (;;) {
    const v = await getJson(`${site}/${env}/version.json`).catch(() => null);
    if (v?.commitId === sha) {
      live[env] = v;
      console.log(`✓ ${env} serves ${sha.slice(0, 7)}`);
      break;
    }
    if (Date.now() > deadline) {
      console.log(`::error::${env} still serves ${v?.commitId?.slice(0, 7) ?? 'nothing'}, expected ${sha.slice(0, 7)}`);
      process.exit(1);
    }
    await sleep(10_000);
  }
}

const rows = [];
for (const [env, v] of Object.entries(live)) {
  for (const tag of v.tags) {
    const url = `${site}/${env}/i18n/v1/${tag}.json`;
    const plain = await get(url);
    const etag = plain.headers.get('etag');
    await plain.arrayBuffer();
    const cond = await get(url, { headers: { 'if-none-match': etag } });
    await cond.arrayBuffer();
    const gz = await get(url, { headers: { 'accept-encoding': 'gzip' } });
    const gzEtag = gz.headers.get('etag');
    await gz.arrayBuffer().catch(() => {});
    const d = decodeEtag(etag);
    rows.push(`| ${env} | ${tag} | \`${etag}\` | ${d?.mtime ?? '?'} | ${d?.size ?? '?'} | ${cond.status} | \`${gzEtag}\` |`);
  }
}

summary([
  '### Live site (option B: what the BFF sees)',
  '',
  `Site: ${site}`,
  '',
  '| Env | Tag | ETag (identity) | ETag mtime | Size | If-None-Match → | ETag (gzip) |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  '',
  '`If-None-Match → 304` shows GitHub Pages answers conditional requests itself, so the BFF can pass them through.',
  'The gzip ETag differs from the identity ETag, which is why the BFF always sends `Accept-Encoding: identity`.',
].join('\n'));
