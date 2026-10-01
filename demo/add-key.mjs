// Adds or changes a key in every locale file on an environment branch, the way a contributor would:
// a short-lived content branch from the environment branch, validated, then a PR (or a direct merge).
//
//   node demo/add-key.mjs                                   demo key puk.section.help-link → PR into sit
//   node demo/add-key.mjs --direct                          same, but squash-merged into sit and pushed
//   node demo/add-key.mjs --key puk.section.request-puk \
//       --value en-US="Get PUK now" --value fr-FR="Obtenir le PUK" --value fr-CI="Avoir mon PUK" \
//       --value pt-PT="Obter PUK" --env sit --direct        change an existing value
//
// Every locale file on the branch must get a value (the completeness check would fail otherwise).
// For an existing key, files without a --value keep their current value.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { report, validateLocales } from '../scripts/lib/locales.mjs';

const DEMO = {
  key: 'puk.section.help-link',
  values: {
    'en-US': 'Need help? Chat to us in the MTN app.',
    'fr-FR': "Besoin d'aide ? Discutez avec nous dans l'application MTN.",
    'fr-CI': "Besoin d'aide ? Écrivez-nous dans l'appli MTN.",
    'pt-PT': 'Precisa de ajuda? Fale connosco na app MTN.',
  },
};

// ---------- arguments ----------
const args = process.argv.slice(2);
const opt = { env: 'sit', direct: false, key: null, values: {} };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--direct') opt.direct = true;
  else if (a === '--env') opt.env = args[++i];
  else if (a === '--key') opt.key = args[++i];
  else if (a === '--value') {
    const [tag, ...rest] = args[++i].split('=');
    opt.values[tag] = rest.join('=');
  } else die(`unknown argument ${a}`);
}
if (!opt.key) Object.assign(opt, { key: DEMO.key, values: DEMO.values });
const BRANCH = { sit: 'sit', qa: 'qa', uat: 'uat', prod: 'main', main: 'main' };
const target = BRANCH[opt.env] ?? die(`unknown environment ${opt.env}`);
const path = opt.key.split('.');
if (path.length < 2) die('the key must start with the journey, e.g. puk.section.help-link');

// ---------- git helpers ----------
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (...a) => {
  console.log(`$ git ${a.join(' ')}`);
  return git(...a);
};
const config = JSON.parse(readFileSync(new URL('../bff/config.json', import.meta.url), 'utf8'));

if (git('status', '--porcelain')) die('commit or stash your changes first');
const original = git('branch', '--show-current');
const slug = `${opt.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${Date.now().toString(36)}`;
const work = `content/${slug}`;

try {
  run('fetch', 'origin', '--quiet');
  run('switch', '--quiet', '-c', work, `origin/${target}`);

  // ---------- edit every locale file ----------
  const files = readdirSync('i18n').filter(f => f.endsWith('.json')).sort();
  const changes = [];
  for (const f of files) {
    const tag = f.replace(/\.json$/, '');
    const file = join('i18n', f);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const parent = path.slice(0, -1).reduce((o, k) => (o[k] ??= {}), data);
    const leaf = path.at(-1);
    const before = parent[leaf];
    const value = opt.values[tag] ?? before;
    if (value === undefined) fail(`no --value for ${tag}, and ${tag}.json does not have ${opt.key} yet`);
    if (value === before) continue;
    parent[leaf] = value;
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    changes.push(`${tag}: ${before === undefined ? 'added' : `"${before}" →`} "${value}"`);
  }
  if (!changes.length) fail(`${opt.key} already has these values on ${target}`);
  console.log(`\n${opt.key} on ${target}:\n  ${changes.join('\n  ')}\n`);

  const result = validateLocales('i18n');
  report(result);
  if (result.errors.length) fail('validation failed: nothing was committed');
  console.log('✓ validation passed\n');

  const verb = changes.some(c => c.includes('added')) ? 'Add' : 'Change';
  run('add', 'i18n');
  run('commit', '--quiet', '-m', `${verb} ${opt.key} (${target})`);

  if (opt.direct) {
    // What merging the PR with "Squash and merge" does.
    run('switch', '--quiet', target);
    run('merge', '--quiet', '--ff-only', `origin/${target}`);
    run('merge', '--quiet', '--squash', work);
    run('commit', '--quiet', '-m', `${verb} ${opt.key}`);
    run('push', '--quiet', 'origin', target);
    run('branch', '--quiet', '-D', work);
    console.log(`\n✓ Merged into ${target} and pushed. trigger-publish → publish will deploy ${opt.env.toUpperCase()} in about a minute:`);
    console.log(`  https://github.com/${config.repo}/actions`);
    console.log('  Then press "Launch app" in the demo app (npm run app) for this environment: 200 with a new ETag and the key highlighted.');
  } else {
    run('push', '--quiet', '-u', 'origin', work);
    console.log('\n✓ Content branch pushed. Open the PR, let "validate" pass, then "Squash and merge":');
    console.log(`  https://github.com/${config.repo}/compare/${target}...${work}?expand=1`);
  }
} catch (e) {
  console.error(`\n✗ ${e.stderr?.toString().trim() || e.message}`);
  process.exitCode = 1;
  // The tree was clean when we started, so discarding is safe: it only drops this script's own edits.
  if (git('branch', '--show-current') === work) git('reset', '--quiet', '--hard');
} finally {
  try { git('switch', '--quiet', original); } catch { /* stay where we are */ }
  if (process.exitCode && git('branch', '--list', work)) git('branch', '--quiet', '-D', work);
}

function fail(message) {
  throw new Error(message);
}

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(2);
}
