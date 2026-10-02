// Compares the freshly built site with the live one, before deploying.
//
// Usage: node scripts/compare-live.mjs --site <pages base url> [--out out] [--envs sit,qa,uat,prod]
//                                      [--guard prod] [--preserve-mtime]
//
// 1. Changed environments: the branch head differs from the live version.json.
// 2. PROD guard: if no PROD locale file changed, every PROD file must be byte-identical to the live
//    one. If not, a workflow or script change is about to alter PROD content, and the deploy stops.
//    "No locale file changed" means main did not change, or (once the live version.json lists
//    per-file commits) main changed but every file's last commit is the same as live.
// 3. With --preserve-mtime: a changed environment's commit time must be later than the live one,
//    otherwise new content could be served with an old ETag.
//
// Outputs (GITHUB_OUTPUT): changed=["sit",...]  heads={"sit":"<sha>",...}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, getJson, setOutput, summary } from './lib/site.mjs';

const opt = { out: 'out', envs: 'sit,qa,uat,prod', guard: 'prod', preserveMtime: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--preserve-mtime') opt.preserveMtime = true;
  else opt[args[i].replace(/^--/, '')] = args[++i];
}
if (!opt.site) {
  console.error('--site is required');
  process.exit(2);
}
const site = opt.site.replace(/\/$/, '');

const changed = [];
const heads = {};
const rows = [];
let failed = false;

for (const env of opt.envs.split(',')) {
  const local = JSON.parse(readFileSync(join(opt.out, env, 'version.json'), 'utf8'));
  const live = await getJson(`${site}/${env}/version.json`);
  heads[env] = local.commitId;
  const isChanged = !live || live.commitId !== local.commitId;
  if (isChanged) changed.push(env);
  rows.push(`| ${env} | ${live ? live.commitId.slice(0, 7) : '—'} | ${local.commitId.slice(0, 7)} | ${isChanged ? '**changed**' : 'unchanged'} |`);

  if (opt.preserveMtime && isChanged && live && local.publishedAt <= live.publishedAt) {
    console.log(`::error::${env}: new commit time ${local.publishedAt} is not later than the live ${live.publishedAt}; with --preserve-mtime the ETag might not change`);
    failed = true;
  }

  const sameFiles = Boolean(live?.files && local.files)
    && JSON.stringify(Object.keys(local.files).sort()) === JSON.stringify(Object.keys(live.files).sort())
    && Object.entries(local.files).every(([tag, f]) => live.files[tag].commitId === f.commitId);
  if (env === opt.guard && isChanged && sameFiles) console.log(`${env}: branch moved, but no locale file changed: checking that the files are byte-identical`);

  if (env === opt.guard && live && (!isChanged || sameFiles)) {
    const tags = new Set([...local.tags, ...live.tags]);
    let identical = true;
    for (const tag of tags) {
      const built = local.tags.includes(tag) ? readFileSync(join(opt.out, env, 'i18n', 'v1', `${tag}.json`)) : null;
      const res = await get(`${site}/${env}/i18n/v1/${tag}.json`, { bust: true });
      const served = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      if (!built || !served || !built.equals(served)) {
        console.log(`::error::PROD guard: ${tag}.json would change although no locale file on main did (${!built ? 'removed' : !served ? 'added' : 'content differs'})`);
        identical = false;
        failed = true;
      }
    }
    if (identical) console.log(`✓ PROD guard: ${tags.size} file(s) byte-identical to the live site`);
  }
}

summary(['### Environments', '', '| Environment | Live commit | Built commit | Status |', '|---|---|---|---|', ...rows, ''].join('\n'));
setOutput('changed', JSON.stringify(changed));
setOutput('heads', JSON.stringify(heads));
console.log(`changed: ${JSON.stringify(changed)}`);
if (failed) process.exit(1);
