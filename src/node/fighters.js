import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { validateFighter, slugify } from '../fighter.js';

export function loadFighterFile(file) {
  const id = slugify(path.basename(file).replace(/\.ya?ml$/i, ''));
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`YAML parse error: ${err.message}`], fighter: null, file };
  }
  return { ...validateFighter(raw, id), file };
}

export function loadFighters(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /\.ya?ml$/i.test(n))
    .sort()
    .map((n) => loadFighterFile(path.join(dir, n)));
}

// Accept a fighter id ("tortoise") or a path ("./my-bot.yaml").
export function resolveFighter(ref, dir) {
  const asPath = path.resolve(ref);
  if (/\.ya?ml$/i.test(ref) && fs.existsSync(asPath)) return loadFighterFile(asPath);
  const all = loadFighters(dir);
  const hit = all.find((r) => r.fighter && (r.fighter.id === ref || r.fighter.name.toLowerCase() === String(ref).toLowerCase()));
  if (!hit) {
    const known = all.filter((r) => r.fighter).map((r) => r.fighter.id).join(', ');
    return { ok: false, errors: [`unknown fighter "${ref}". Known: ${known}`], fighter: null };
  }
  return hit;
}
