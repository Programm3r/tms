// Starts the bootstrap BFF locally.
//
//   node bff/server.mjs              all four environments (SIT 8081, QA 8082, UAT 8083, PROD 8084)
//   node bff/server.mjs --env sit    one environment
//   node bff/server.mjs --etag-mode content   content-hash ETags instead of GitHub's (see bff.mjs)
//
// Set I18N_SITE_URL to point at a different GitHub Pages site (e.g. a fork).
import { createBff, loadConfig } from './bff.mjs';

const config = loadConfig();
const only = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : null;
const etagMode = process.argv.includes('--etag-mode') ? process.argv[process.argv.indexOf('--etag-mode') + 1] : null;
const envs = Object.values(config.environments).filter(e => !only || e.env === only).map(e => ({ ...e, etagMode: etagMode ?? e.etagMode }));
if (!envs.length) {
  console.error(`Unknown environment "${only}". Known: ${Object.keys(config.environments).join(', ')}`);
  process.exit(2);
}

for (const e of envs) {
  createBff(e).listen(e.port, () => {
    console.log(`${e.env.toUpperCase().padEnd(4)} BFF  http://localhost:${e.port}/bootstrap/v1/localisation/{tag}  →  ${e.baseUrl}  [${e.tags.join(', ')}]  ETag: ${e.etagMode}`);
  });
}
