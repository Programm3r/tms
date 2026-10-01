// Promotes one environment branch to the next with a merge commit (never squash or rebase).
//
//   node demo/promote.mjs sit qa             prints the PR link (merge it with "Create a merge commit")
//   node demo/promote.mjs sit qa --direct    merges sit into qa locally with --no-ff and pushes
//
// Allowed: sit → qa, qa → uat, uat → main
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [from, to] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const direct = process.argv.includes('--direct');
const ALLOWED = { sit: 'qa', qa: 'uat', uat: 'main' };
const config = JSON.parse(readFileSync(new URL('../bff/config.json', import.meta.url), 'utf8'));

if (!from || ALLOWED[from] !== to) {
  console.error('Usage: node demo/promote.mjs <sit qa | qa uat | uat main> [--direct]');
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (...a) => {
  console.log(`$ git ${a.join(' ')}`);
  return git(...a);
};

if (git('status', '--porcelain')) {
  console.error('Commit or stash your changes first.');
  process.exit(1);
}
const original = git('branch', '--show-current');

try {
  run('fetch', 'origin', '--quiet');
  const pending = git('log', '--oneline', `origin/${to}..origin/${from}`);
  if (!pending) {
    console.log(`\n${to} already contains everything on ${from}. Nothing to promote.`);
    process.exit(0);
  }
  const files = git('diff', '--stat', `origin/${to}...origin/${from}`, '--', 'i18n');
  console.log(`\nCommits on ${from} not yet on ${to}:\n${pending.replace(/^/gm, '  ')}\n`);
  console.log(`Locale changes:\n${(files || '  (none)').replace(/^/gm, '  ')}\n`);

  if (direct) {
    run('switch', '--quiet', to);
    run('merge', '--quiet', '--ff-only', `origin/${to}`);
    try {
      run('merge', '--quiet', '--no-ff', `origin/${from}`, '-m', `Promote ${from} → ${to}`);
    } catch (e) {
      git('merge', '--abort');
      throw new Error(`merge conflict promoting ${from} → ${to}; resolve it in a PR instead:\n${e.stderr ?? ''}`);
    }
    run('push', '--quiet', 'origin', to);
    console.log(`\n✓ ${from} merged into ${to} (merge commit) and pushed. publish will deploy ${to === 'main' ? 'PROD' : to.toUpperCase()}:`);
    console.log(`  https://github.com/${config.repo}/actions`);
  } else {
    console.log('Open the promotion PR and merge it with "Create a merge commit":');
    console.log(`  https://github.com/${config.repo}/compare/${to}...${from}?expand=1&title=${encodeURIComponent(`Promote ${from} → ${to}`)}`);
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  try { git('switch', '--quiet', original); } catch { /* stay where we are */ }
}
