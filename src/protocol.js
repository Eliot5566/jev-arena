import { MOVES, ACTS, isMovement } from './engine/actions.js';
import { ZONE } from './engine/constants.js';

// Every brain speaks the TypeSafe System One protocol:
//   request  { model, state, questions: { name: {type, instructions, criteria?} } }
//   response { model, answers: { name: {type, choice|noul|score, probabilities?, confidence?} }, usage }
// Jev speaks it natively; Laya and kev ship compatible servers; the mock and LLM brains translate.
//
// One decision = one request with parallel questions over the same state:
//   move      Choice over the legal movements
//   act       Choice over the legal actions (including "wait")
//   reflex_N  Noul per reflex ("is this true right now?")

export const RULES =
  'Two robot fighters duel for 60 seconds in a 24x14m arena with round pillars. Knock the enemy out, or have more health when time runs out. ' +
  'Every moment each fighter picks one movement and one action at the same time, so it can shoot while strafing or shield while retreating. ' +
  'Energy regenerates constantly. Bolts are cheap and fast; a target moving sideways at medium or long range can slip them. ' +
  'Heavy shots hit hard but take 1 second to charge, and the enemy can see the charge. Shields block most shot damage, but a melee strike breaks them. ' +
  'Dashing makes a fighter untouchable for a moment. Pillars block shots and line of sight. Power-ups: repair (+30 health), battery (+60 energy), overdrive (+50% damage for 6s). ' +
  `From ${ZONE.startAt}s a zone closes in toward the open center; standing outside it costs ${ZONE.dps} health per second, so hiding at the edges loses late.`;

function criteriaFor(options, catalog, fighter) {
  const out = {};
  for (const a of options) {
    const note = fighter.actions?.[a];
    out[a] = note ? `${catalog[a]} Coach's note: ${note}` : catalog[a];
  }
  return out;
}

export function buildRequest({ fighter, observation, available, model = 'jev-latest' }) {
  const style = `You pilot the fighter "${fighter.name}". Its coach wrote this fighting style: "${fighter.strategy}"`;
  const questions = {
    move: {
      type: 'choice',
      instructions: `${style} Following that style, how should ${fighter.name} move right now?`,
      criteria: criteriaFor(available.moves, MOVES, fighter),
    },
  };
  // When nothing is ready (everything on cooldown), the only action is "wait": don't ask.
  if (available.acts.length > 1) {
    questions.act = {
      type: 'choice',
      instructions: `${style} Following that style, what should ${fighter.name} do with its weapons and gear right now, while it keeps moving?`,
      criteria: criteriaFor(available.acts, ACTS, fighter),
    };
  }
  const all = [...available.moves, ...available.acts];
  fighter.reflexes.forEach((r, i) => {
    if (!all.includes(r.do)) return;
    questions[`reflex_${i}`] = {
      type: 'noul',
      instructions: `Judge the situation from ${fighter.name}'s point of view. Is this true right now: ${r.when}`,
    };
  });
  return {
    model,
    state: { rules: RULES, you_are: fighter.name, situation: observation },
    questions,
  };
}

// Turn an answer set into a movement and an action. For each of the two, in order of authority:
//   1. the first reflex of that kind whose probability clears its threshold
//   2. the brain's choice, if it is confident enough
//   3. the fallback: the fighter's fallback movement, or "wait" for the action
export function resolveDecision({ fighter, response, available }) {
  const answers = response?.answers || {};
  const reflexes = fighter.reflexes.map((r, i) => {
    const a = answers[`reflex_${i}`];
    const p = a && typeof a.noul === 'number' ? clamp01(a.noul) : null;
    return { p, threshold: r.threshold, do: r.do, fired: false };
  });

  const pick = (key, options, fallback) => {
    const ans = answers[key] || {};
    const probabilities = normalizeProbs(ans.probabilities, options);
    const confidence = typeof ans.confidence === 'number' ? clamp01(ans.confidence) : confidenceOf(probabilities);
    const top = pickTop(probabilities, ans.choice, options);
    for (let i = 0; i < reflexes.length; i++) {
      const r = reflexes[i];
      if (isMovement(r.do) !== (key === 'move')) continue;
      if (r.p !== null && r.p >= r.threshold && options.includes(r.do)) {
        r.fired = true;
        return { action: r.do, source: `reflex ${i + 1}`, probabilities, confidence };
      }
    }
    if (top && confidence >= fighter.min_confidence) return { action: top, source: 'strategy', probabilities, confidence };
    return { action: fallback, source: top ? 'fallback (low confidence)' : 'fallback (no answer)', probabilities, confidence };
  };

  const moveFallback = available.moves.includes(fighter.fallback) ? fighter.fallback : available.moves[0] || 'advance';
  const move = pick('move', available.moves, moveFallback);
  const act =
    available.acts.length > 1
      ? pick('act', available.acts, 'wait')
      : { action: 'wait', source: 'nothing ready', probabilities: { wait: 1 }, confidence: 1 };
  return { move, act, reflexes };
}

function pickTop(probabilities, stated, available) {
  if (stated && available.includes(stated)) return stated;
  let best = null;
  let bp = 0;
  for (const [k, p] of Object.entries(probabilities)) {
    if (p > bp) {
      bp = p;
      best = k;
    }
  }
  return best;
}

export function normalizeProbs(probs, available) {
  const out = {};
  let total = 0;
  for (const a of available) {
    const p = probs && typeof probs[a] === 'number' && probs[a] > 0 ? probs[a] : 0;
    out[a] = p;
    total += p;
  }
  if (total <= 0) return out;
  for (const a of available) out[a] = out[a] / total;
  return out;
}

// 1 - normalized entropy: 1 when all mass is on one option, 0 when it is spread evenly.
export function confidenceOf(probabilities) {
  const ps = Object.values(probabilities).filter((p) => p > 0);
  const n = Object.keys(probabilities).length;
  if (n <= 1 || ps.length === 0) return ps.length ? 1 : 0;
  let h = 0;
  for (const p of ps) h -= p * Math.log(p);
  return clamp01(1 - h / Math.log(n));
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
