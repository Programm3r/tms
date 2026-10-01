// Adds or changes a key in every locale file on an environment branch, the way a contributor would:
// a short-lived content branch from the environment branch, validated, then a PR (or a direct merge).
//
//   node demo/add-key.mjs               demo key puk.section.help-link → PR into sit.
//                                       Added if the branch doesn't have it yet; otherwise every language
//                                       switches to a different wording, so each run is a visible change.
//   node demo/add-key.mjs --direct      same, but squash-merged into sit and pushed
//   node demo/add-key.mjs --dry-run     show and validate the change, then discard it
//   node demo/add-key.mjs --env qa      the same on another environment branch (normally: promote instead)
//
//   node demo/add-key.mjs --key puk.section.request-puk --value en-US="Get PUK now" --direct
//                                       add or change any key
//
// A new key needs a value for every locale file on the branch (the completeness check requires it).
// For an existing key, files without a --value keep their current value.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { report, validateLocales } from '../scripts/lib/locales.mjs';

// Demo key: the first wording is used when the key is added. Later runs switch every language to a
// different wording at random.
const DEMO = {
  key: 'puk.section.help-link',
  wordings: {
    'en-US': [
      'Need help? Chat to us in the MTN app.',
      'Questions? Our team is one tap away in the MTN app.',
      'Stuck? Get help straight away in the MTN app.',
      'Need a hand? Message us in the MTN app.',
    ],
    'fr-FR': [
      "Besoin d'aide ? Discutez avec nous dans l'application MTN.",
      "Une question ? Notre équipe vous répond dans l'application MTN.",
      "Bloqué ? Obtenez de l'aide tout de suite dans l'application MTN.",
      "Besoin d'un coup de main ? Écrivez-nous dans l'application MTN.",
    ],
    'fr-CI': [
      "Besoin d'aide ? Écrivez-nous dans l'appli MTN.",
      "Une question ? On te répond vite dans l'appli MTN.",
      "Tu es bloqué ? Trouve de l'aide dans l'appli MTN.",
      "Besoin d'un coup de main ? Contacte-nous dans l'appli MTN.",
    ],
    'pt-PT': [
      'Precisa de ajuda? Fale connosco na app MTN.',
      'Tem dúvidas? A nossa equipa responde na app MTN.',
      'Ficou sem saída? Obtenha ajuda já na app MTN.',
      'Precisa de uma mão? Envie-nos uma mensagem na app MTN.',
    ],
  },
};

/** Demo mode: first wording when adding; otherwise a random wording different from the current one. */
function demoValue(tag, current) {
  const options = DEMO.wordings[tag];
  if (!options) return current;   // a locale the demo has no wordings for keeps its value
  if (current === undefined) return options[0];
  const others = options.filter(o => o !== current);
  return others[Math.floor(Math.random() * others.length)];
}

// ---------- arguments ----------
const args = process.argv.slice(2);
const opt = { env: 'sit', direct: false, dryRun: false, key: null, values: {} };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--direct') opt.direct = true;
  else if (a === '--dry-run') opt.dryRun = true;
  else if (a === '--env') opt.env = args[++i];
  else if (a === '--key') opt.key = args[++i];
  else if (a === '--value') {
    const [tag, ...rest] = args[++i].split('=');
    opt.values[tag] = rest.join('=');
  } else die(`unknown argument ${a}`);
}
const demo = !opt.key;
if (demo) opt.key = DEMO.key;
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
let keepWorkBranch = false;

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
    const value = demo ? demoValue(tag, before) : (opt.values[tag] ?? before);
    if (value === undefined) fail(`no ${demo ? 'demo wording' : '--value'} for ${tag}, and ${tag}.json does not have ${opt.key} yet`);
    if (value === before) continue;
    parent[leaf] = value;
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    changes.push({ tag, before, value });
  }
  if (!changes.length) fail(`${opt.key} already has these values on ${target}`);

  const added = changes.some(c => c.before === undefined);
  const verb = added ? 'Add' : 'Change';
  console.log(`\n${verb} ${opt.key} on ${target}:`);
  for (const c of changes) console.log(`  ${c.tag}: ${c.before === undefined ? '(new)' : `"${c.before}"`} → "${c.value}"`);
  console.log('');

  const result = validateLocales('i18n');
  report(result);
  if (result.errors.length) fail('validation failed: nothing was committed');
  console.log('✓ validation passed\n');

  if (opt.dryRun) {
    console.log('Dry run: nothing committed or pushed.');
    git('reset', '--quiet', '--hard');
  } else {
    run('add', 'i18n');
    run('commit', '--quiet', '-m', `${verb} ${opt.key} (${target})`);

    if (opt.direct) {
      // What merging the PR with "Squash and merge" does.
      run('switch', '--quiet', target);
      run('merge', '--quiet', '--ff-only', `origin/${target}`);
      run('merge', '--quiet', '--squash', work);
      run('commit', '--quiet', '-m', `${verb} ${opt.key}`);
      run('push', '--quiet', 'origin', target);
      console.log(`\n✓ Merged into ${target} and pushed. trigger-publish → publish will deploy ${opt.env.toUpperCase()} in about a minute:`);
      console.log(`  https://github.com/${config.repo}/actions`);
      console.log(`  Then press "Launch app" in the demo app (npm run app) for ${opt.env.toUpperCase()}: 200 · content updated, with the ${added ? 'new key' : 'changed values'} highlighted.`);
    } else {
      run('push', '--quiet', '-u', 'origin', work);
      keepWorkBranch = true;
      console.log('\n✓ Content branch pushed. Open the PR, let "validate" pass, then "Squash and merge":');
      console.log(`  https://github.com/${config.repo}/compare/${target}...${work}?expand=1`);
    }
  }
} catch (e) {
  console.error(`\n✗ ${e.stderr?.toString().trim() || e.message}`);
  process.exitCode = 1;
  // The tree was clean when we started, so discarding is safe: it only drops this script's own edits.
  if (git('branch', '--show-current') === work) git('reset', '--quiet', '--hard');
} finally {
  try { git('switch', '--quiet', original); } catch { /* stay where we are */ }
  if (!keepWorkBranch && git('branch', '--list', work)) git('branch', '--quiet', '-D', work);
}

function fail(message) {
  throw new Error(message);
}

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(2);
}
