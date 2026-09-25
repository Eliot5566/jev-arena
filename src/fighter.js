import { ACTION_IDS, MOVEMENT_ACTIONS } from './engine/actions.js';

// A fighter is plain English plus a few knobs. These limits keep the ladder fair
// (everyone gets the same prompt budget) and keep every decision cheap.
export const LIMITS = {
  name: 24,
  tagline: 90,
  strategyMin: 20,
  strategyMax: 700,
  actionNote: 160,
  reflexes: 4,
  reflexWhen: 160,
};

export const DEFAULTS = {
  color: '#38bdf8',
  fallback: 'strafe_left',
  min_confidence: 0.2,
  threshold: 0.7,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

// Returns { ok, errors, fighter } where fighter is the normalized spec.
export function validateFighter(raw, id = undefined) {
  const errors = [];
  const f = raw && typeof raw === 'object' ? raw : {};
  const str = (x) => (typeof x === 'string' ? x.trim() : '');

  const name = str(f.name);
  if (!name) errors.push('name is required');
  else if (name.length > LIMITS.name) errors.push(`name must be at most ${LIMITS.name} characters`);

  const author = str(f.author);
  if (!author) errors.push('author is required (your GitHub handle)');

  const tagline = str(f.tagline);
  if (tagline.length > LIMITS.tagline) errors.push(`tagline must be at most ${LIMITS.tagline} characters`);

  const color = str(f.color) || DEFAULTS.color;
  if (!HEX.test(color)) errors.push('color must look like "#38bdf8"');

  const strategy = str(f.strategy).replace(/\s+/g, ' ');
  if (strategy.length < LIMITS.strategyMin) errors.push(`strategy must be at least ${LIMITS.strategyMin} characters`);
  if (strategy.length > LIMITS.strategyMax) errors.push(`strategy must be at most ${LIMITS.strategyMax} characters (it is ${strategy.length})`);

  const actions = {};
  if (f.actions !== undefined && f.actions !== null) {
    if (typeof f.actions !== 'object' || Array.isArray(f.actions)) errors.push('actions must be a map of action -> note');
    else {
      for (const [k, note] of Object.entries(f.actions)) {
        if (!ACTION_IDS.includes(k)) errors.push(`actions.${k} is not a move (moves: ${ACTION_IDS.join(', ')})`);
        else if (typeof note !== 'string' || !note.trim()) errors.push(`actions.${k} must be a sentence`);
        else if (note.trim().length > LIMITS.actionNote) errors.push(`actions.${k} must be at most ${LIMITS.actionNote} characters`);
        else actions[k] = note.trim().replace(/\s+/g, ' ');
      }
    }
  }

  const reflexes = [];
  if (f.reflexes !== undefined && f.reflexes !== null) {
    if (!Array.isArray(f.reflexes)) errors.push('reflexes must be a list');
    else {
      if (f.reflexes.length > LIMITS.reflexes) errors.push(`at most ${LIMITS.reflexes} reflexes`);
      f.reflexes.slice(0, LIMITS.reflexes).forEach((r, i) => {
        const when = str(r?.when).replace(/\s+/g, ' ');
        const doAction = str(r?.do);
        const threshold = r?.threshold === undefined ? DEFAULTS.threshold : Number(r.threshold);
        if (!when) errors.push(`reflexes[${i}].when is required`);
        else if (when.length > LIMITS.reflexWhen) errors.push(`reflexes[${i}].when must be at most ${LIMITS.reflexWhen} characters`);
        if (!ACTION_IDS.includes(doAction)) errors.push(`reflexes[${i}].do must be one of: ${ACTION_IDS.join(', ')}`);
        if (!(threshold >= 0.5 && threshold <= 0.99)) errors.push(`reflexes[${i}].threshold must be between 0.5 and 0.99`);
        reflexes.push({ when, do: doAction, threshold });
      });
    }
  }

  const fallback = str(f.fallback) || DEFAULTS.fallback;
  if (!MOVEMENT_ACTIONS.includes(fallback)) errors.push(`fallback must be a movement: ${MOVEMENT_ACTIONS.join(', ')}`);

  const minConfidence = f.min_confidence === undefined ? DEFAULTS.min_confidence : Number(f.min_confidence);
  if (!(minConfidence >= 0 && minConfidence <= 0.9)) errors.push('min_confidence must be between 0 and 0.9');

  const fighter = {
    id: id || slugify(name || 'fighter'),
    name,
    author,
    tagline,
    color,
    strategy,
    actions,
    reflexes,
    fallback,
    min_confidence: minConfidence,
  };
  return { ok: errors.length === 0, errors, fighter };
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'fighter';
}

// Minimal YAML writer for the fighter schema, used by the in-browser Fighter Lab.
export function fighterToYaml(f) {
  const q = (s) => JSON.stringify(String(s));
  const lines = [];
  lines.push(`name: ${q(f.name)}`);
  lines.push(`author: ${q(f.author)}`);
  if (f.tagline) lines.push(`tagline: ${q(f.tagline)}`);
  lines.push(`color: ${q(f.color || DEFAULTS.color)}`);
  lines.push('strategy: >');
  for (const chunk of wrap(f.strategy, 88)) lines.push(`  ${chunk}`);
  const notes = Object.entries(f.actions || {});
  if (notes.length) {
    lines.push('actions:');
    for (const [k, note] of notes) lines.push(`  ${k}: ${q(note)}`);
  }
  if ((f.reflexes || []).length) {
    lines.push('reflexes:');
    for (const r of f.reflexes) {
      lines.push(`  - when: ${q(r.when)}`);
      lines.push(`    do: ${r.do}`);
      lines.push(`    threshold: ${r.threshold}`);
    }
  }
  lines.push(`fallback: ${f.fallback || DEFAULTS.fallback}`);
  lines.push(`min_confidence: ${f.min_confidence ?? DEFAULTS.min_confidence}`);
  return lines.join('\n') + '\n';
}

function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) {
      out.push(line);
      line = w;
    } else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}
