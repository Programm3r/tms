// Usage: node scripts/validate.mjs [i18n-dir]
// Runs on every PR and push (validate.yml). Exit code 1 if any locale file breaks the rules.
import { report, validateLocales } from './lib/locales.mjs';

const dir = process.argv[2] ?? 'i18n';
const result = validateLocales(dir);
report(result);

if (result.errors.length) {
  console.error(`✗ ${result.errors.length} error(s) in ${dir}`);
  process.exit(1);
}
console.log(`✓ ${result.locales.size} locale file(s) in ${dir} are valid: ${[...result.locales.keys()].join(', ')}`);
