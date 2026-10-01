// Builds the GitHub Pages site: one folder per environment, each built only from its own branch.
//
// Usage: node scripts/build-site.mjs [--out out] [--preserve-mtime] sit=src/sit qa=src/qa uat=src/uat prod=src/prod
//
// Output:
//   out/index.html                       overview of what each environment serves
//   out/<env>/version.json               { env, commitId, publishedAt, tags }
//   out/<env>/i18n/v1/<tag>.json         source file unchanged, plus _meta
//
// _meta.publishedAt is the commit time of the branch head (not the build time), so rebuilding an
// unchanged branch produces byte-identical files. The PROD guard in compare-live.mjs relies on this.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { report, validateLocales } from './lib/locales.mjs';

let out = 'out';
let preserveMtime = false;
const envs = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--preserve-mtime') preserveMtime = true;
  else {
    const [env, dir] = args[i].split('=');
    if (!env || !dir) usage();
    envs.push({ env, dir });
  }
}
if (!envs.length) usage();

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

rmSync(out, { recursive: true, force: true });
const built = [];
let failed = false;

for (const { env, dir } of envs) {
  const result = validateLocales(join(dir, 'i18n'));
  report(result);
  if (result.errors.length) {
    console.error(`✗ ${env}: ${result.errors.length} error(s), nothing will be deployed`);
    failed = true;
    continue;
  }

  const commitId = git(dir, 'rev-parse', 'HEAD');
  const epoch = Number(git(dir, 'show', '-s', '--format=%ct', 'HEAD'));
  const publishedAt = new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');
  const tags = [...result.locales.keys()].sort();
  const target = join(out, env, 'i18n', 'v1');
  mkdirSync(target, { recursive: true });

  for (const tag of tags) {
    const file = join(target, `${tag}.json`);
    const { data } = result.locales.get(tag);
    writeFileSync(file, JSON.stringify({ _meta: { tag, publishedAt, commitId }, ...data }, null, 2) + '\n');
    // Optional experiment: GitHub Pages builds the ETag from mtime + size. Pinning mtime to the
    // commit time keeps an unchanged environment's ETags stable across deploys, if Pages keeps it.
    if (preserveMtime) utimesSync(file, epoch, epoch);
  }
  writeFileSync(join(out, env, 'version.json'), JSON.stringify({ env, commitId, publishedAt, tags }, null, 2) + '\n');
  built.push({ env, commitId, publishedAt, tags });
  console.log(`✓ ${env.padEnd(5)} ${commitId.slice(0, 7)}  ${publishedAt}  ${tags.join(', ')}`);
}

if (failed) process.exit(1);
writeFileSync(join(out, 'index.html'), indexPage(built));

function indexPage(rows) {
  const repo = process.env.GITHUB_REPOSITORY;
  const commit = c => (repo ? `<a href="https://github.com/${repo}/commit/${c}">${c.slice(0, 7)}</a>` : c.slice(0, 7));
  const body = rows
    .map(r => `<tr><th>${r.env}</th><td>${commit(r.commitId)}</td><td>${r.publishedAt}</td><td>${r.tags
      .map(t => `<a href="${r.env}/i18n/v1/${t}.json">${t}</a>`)
      .join(' ')}</td><td><a href="${r.env}/version.json">version.json</a></td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TMS locale files</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 2rem auto; max-width: 56rem; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #8884; }
  td a { margin-right: .5rem; }
</style>
</head>
<body>
<h1>TMS locale files</h1>
<p>Published by the <code>publish</code> workflow. Each environment is built only from its own branch.</p>
<table>
<thead><tr><th>Environment</th><th>Commit</th><th>Published</th><th>Locale files</th><th></th></tr></thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>
`;
}

function usage() {
  console.error('Usage: node scripts/build-site.mjs [--out out] [--preserve-mtime] <env>=<checkout-dir> ...');
  process.exit(2);
}
