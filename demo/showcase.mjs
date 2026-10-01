// End-to-end showcase of option B against the live GitHub Pages site.
// Starts one BFF per environment in-process, then plays through the scenarios.
//
//   node demo/showcase.mjs            (or: npm run showcase)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBff, loadConfig } from '../bff/bff.mjs';
import { decodeEtag, get } from '../scripts/lib/site.mjs';
import { launch, lookup } from './device.mjs';

const config = loadConfig();
const envs = Object.values(config.environments);
const bffLog = [];
const tmp = mkdtempSync(join(tmpdir(), 'tms-showcase-'));
const cache = name => join(tmp, name);

const heading = (n, text) => console.log(`\n\x1b[1m${n}. ${text}\x1b[0m`);
const line = text => console.log(`   ${text}`);
const flushLog = () => {
  for (const l of bffLog.splice(0)) console.log(`   \x1b[2m${l}\x1b[0m`);
};
const check = (ok, text) => console.log(`   ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${text}`);

async function start(e) {
  const server = createBff({ ...e, log: l => bffLog.push(l) });
  await new Promise(r => server.listen(0, r));
  return { server, url: `http://localhost:${server.address().port}` };
}

// 0. Is the site published?
console.log(`Site: ${config.siteUrl}`);
const versions = {};
for (const e of envs) {
  const res = await get(`${config.siteUrl}/${e.env}/version.json`, { bust: true }).catch(err => ({ ok: false, status: err.message }));
  if (!res.ok) {
    console.error(`\n${e.env}/version.json is not available (${res.status}). Publish the site first: see README "One-time GitHub setup".`);
    process.exit(1);
  }
  versions[e.env] = await res.json();
  line(`${e.env.padEnd(4)} serves ${versions[e.env].commitId.slice(0, 7)} (${versions[e.env].publishedAt})  [${versions[e.env].tags.join(', ')}]`);
}

const bffs = Object.fromEntries(await Promise.all(envs.map(async e => [e.env, await start(e)])));

try {
  heading(1, 'First launch on SIT (fr-CI): no device cache');
  const first = await launch({ bffUrl: bffs.sit.url, tag: 'fr-CI', cacheDir: cache('sit'), keys: ['puk:section.request-puk'] });
  flushLog();
  line(`rendered first from ${first.renderedFrom}; BFF → ${first.status}, ${first.bytes} bytes`);
  line(first.outcome);
  check(first.status === 200, `200 with the file and ETag ${first.etag}`);

  heading(2, 'Next launch: the device sends its ETag');
  const second = await launch({ bffUrl: bffs.sit.url, tag: 'fr-CI', cacheDir: cache('sit') });
  flushLog();
  line(`If-None-Match: ${first.etag}; BFF → ${second.status}, ${second.bytes} bytes`);
  check(second.status === 304 && second.bytes === 0, '304 Not Modified, no body: GitHub answered, the BFF passed it through');

  heading(3, 'The ETag the device holds is GitHub\'s, unchanged');
  const url = `${envs.find(e => e.env === 'sit').baseUrl}fr-CI.json`;
  const direct = await get(url);
  await direct.arrayBuffer();
  const originEtag = direct.headers.get('etag');
  const d = decodeEtag(originEtag);
  line(`GitHub Pages: ${originEtag}${d ? `  (mtime ${d.mtime}, ${d.size} bytes)` : ''}`);
  line(`BFF/device  : ${first.etag}`);
  check(originEtag === first.etag, 'identical: the BFF does not compute ETags');

  heading(4, 'Why the BFF always sends Accept-Encoding: identity');
  const gz = await get(url, { headers: { 'accept-encoding': 'gzip' } });
  await gz.arrayBuffer().catch(() => {});
  line(`identity: ${originEtag}`);
  line(`gzip    : ${gz.headers.get('etag')}`);
  check(true, gz.headers.get('etag') !== originEtag
    ? 'different ETags for the same file: a mixed encoding would make devices download again'
    : 'same ETag here (this origin does not vary ETags by encoding)');

  heading(5, 'Environment isolation: the same key in each environment (en-US)');
  for (const e of envs) {
    const r = await launch({ bffUrl: bffs[e.env].url, tag: 'en-US', cacheDir: cache(`iso-${e.env}`), keys: ['puk:section.request-puk'] });
    line(`${e.env.padEnd(4)} @ ${r.meta?.commitId.slice(0, 7) ?? '???????'}  puk:section.request-puk = "${r.values['puk:section.request-puk']}"`);
  }
  bffLog.length = 0;
  line('Each folder is built only from its own branch, so SIT changes never reach PROD until promoted.');

  heading(6, 'Per-environment allowlist: pt-PT is live in SIT only');
  const ptSit = await launch({ bffUrl: bffs.sit.url, tag: 'pt-PT', cacheDir: cache('pt-sit'), keys: ['puk:section.request-puk'] });
  const ptProd = await launch({ bffUrl: bffs.prod.url, tag: 'pt-PT', cacheDir: cache('pt-prod'), keys: ['puk:section.request-puk'] });
  flushLog();
  check(ptSit.status === 200, `SIT  → ${ptSit.status}: "${ptSit.values['puk:section.request-puk']}"`);
  check(ptProd.status === 400, `PROD → ${ptProd.status}: not on PROD's allowlist, no upstream call; device keeps the compiled base file`);

  heading(7, 'Allowlisted but not published: 404 from the BFF, not GitHub\'s HTML page');
  const sitWithExtra = await start({ ...envs.find(e => e.env === 'sit'), tags: ['en-GB'] });
  const missing = await fetch(`${sitWithExtra.url}/bootstrap/v1/localisation/en-GB`);
  const missingBody = await missing.text();
  sitWithExtra.server.close();
  flushLog();
  check(missing.status === 404 && !missing.headers.get('etag'), `${missing.status} ${missingBody} (no ETag forwarded)`);

  heading(8, 'Journeys are namespaces: the same key name resolves independently');
  const res = await fetch(`${bffs.sit.url}/bootstrap/v1/localisation/en-US`);
  const content = await res.json();
  bffLog.length = 0;
  line(`puk:section.refresh = "${lookup(content, 'puk:section.refresh')}"`);
  line(`kmn:section.refresh = "${lookup(content, 'kmn:section.refresh')}"`);

  console.log('\nNext: change a value on the sit branch (PR), wait for the publish workflow, then run');
  console.log('`node demo/device.mjs --env sit --tag fr-CI` twice: 200 with the new ETag, then 304.');
} finally {
  for (const { server } of Object.values(bffs)) server.close();
  rmSync(tmp, { recursive: true, force: true });
}
