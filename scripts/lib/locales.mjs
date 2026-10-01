// Shared locale-file rules, used by validate.mjs (PR check) and build-site.mjs (publish).
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const SOURCE_TAG = 'en-US';
export const TAG_RE = /^[a-z]{2,3}-[A-Z]{2}$/;          // D1: file name is the language tag
const JOURNEY_RE = /^[a-z][a-z0-9-]*$/;                 // D5: top-level objects are journeys (i18next namespaces)
const KEY_RE = /^[A-Za-z0-9_-]+$/;                      // no "." or ":" – they are i18next separators
const UNSAFE_RE = /<\/?[a-z][^>]*>|javascript:/i;       // values are rendered as text; reject markup
const PLACEHOLDER_RE = /{{\s*([\w.]+)\s*}}/g;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function flatten(obj, prefix, out, problems) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!KEY_RE.test(k)) problems.push(`key "${path}": use only letters, digits, "-" and "_"`);
    if (typeof v === 'string') {
      if (!v.trim()) problems.push(`key "${path}": value is empty`);
      if (UNSAFE_RE.test(v)) problems.push(`key "${path}": value contains HTML or a script URL`);
      out.set(path, v);
    } else if (isObject(v)) {
      flatten(v, path, out, problems);
    } else {
      problems.push(`key "${path}": value must be a string or an object`);
    }
  }
  return out;
}

const placeholders = s => [...s.matchAll(PLACEHOLDER_RE)].map(m => m[1]).sort().join(',');

/**
 * Validates every <tag>.json in dir: naming, journey structure, string leaves,
 * content safety, completeness against en-US and matching placeholders.
 * Returns { errors, warnings, locales } where locales maps tag -> { file, data, keys }.
 */
export function validateLocales(dir) {
  const errors = [];
  const warnings = [];
  const locales = new Map();

  for (const name of readdirSync(dir).sort()) {
    if (name === '.gitkeep') continue;
    const file = join(dir, name);
    if (!name.endsWith('.json')) {
      errors.push({ file, message: 'only <language-tag>.json files are allowed here' });
      continue;
    }
    const tag = basename(name, '.json');
    if (!TAG_RE.test(tag)) {
      errors.push({ file, message: `file name must be a language tag such as en-US or fr-CI (got "${tag}")` });
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push({ file, message: `invalid JSON: ${e.message}` });
      continue;
    }
    if (!isObject(data)) {
      errors.push({ file, message: 'the top level must be an object of journeys' });
      continue;
    }

    const problems = [];
    const journeys = Object.keys(data);
    const valid = {};
    for (const j of journeys) {
      if (j === '_meta') problems.push('"_meta" is reserved: the publish workflow adds it');
      else if (!JOURNEY_RE.test(j)) problems.push(`journey "${j}": use lower-case letters, digits and "-"`);
      else if (!isObject(data[j])) problems.push(`journey "${j}": must be an object of keys`);
      else valid[j] = data[j];
    }
    const named = journeys.filter(j => j !== '_meta');
    const sorted = [...named].sort();
    if (named.join() !== sorted.join()) {
      warnings.push({ file, message: `keep journeys in alphabetical order to reduce merge conflicts (${sorted.join(', ')})` });
    }
    const keys = flatten(valid, '', new Map(), problems);
    for (const message of problems) errors.push({ file, message });
    locales.set(tag, { file, data, keys });
  }

  const source = locales.get(SOURCE_TAG);
  if (!source) {
    errors.push({ file: join(dir, `${SOURCE_TAG}.json`), message: `the source locale ${SOURCE_TAG}.json is required` });
  } else {
    for (const [tag, loc] of locales) {
      if (tag === SOURCE_TAG) continue;
      const missing = [...source.keys.keys()].filter(k => !loc.keys.has(k));
      const extra = [...loc.keys.keys()].filter(k => !source.keys.has(k));
      if (missing.length) errors.push({ file: loc.file, message: `missing ${missing.length} key(s) that ${SOURCE_TAG} has: ${missing.join(', ')}` });
      if (extra.length) errors.push({ file: loc.file, message: `${extra.length} key(s) that ${SOURCE_TAG} does not have: ${extra.join(', ')}` });
      for (const [k, v] of loc.keys) {
        const s = source.keys.get(k);
        if (s !== undefined && placeholders(s) !== placeholders(v)) {
          errors.push({ file: loc.file, message: `key "${k}": placeholders differ from ${SOURCE_TAG} ({{${placeholders(s)}}} vs {{${placeholders(v)}}})` });
        }
      }
    }
  }
  return { errors, warnings, locales };
}

/** Prints findings; inside GitHub Actions they become PR annotations. */
export function report({ errors, warnings }) {
  const gh = Boolean(process.env.GITHUB_ACTIONS);
  const where = f => relative(process.cwd(), f).replaceAll('\\', '/');
  for (const w of warnings) console.log(gh ? `::warning file=${where(w.file)}::${w.message}` : `warning  ${where(w.file)}: ${w.message}`);
  for (const e of errors) console.log(gh ? `::error file=${where(e.file)}::${e.message}` : `error    ${where(e.file)}: ${e.message}`);
}
