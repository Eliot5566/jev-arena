// The mock brain: an offline stand-in that speaks the System One protocol with hand-written
// heuristics. It skims the fighter's strategy for keywords, so different fighters still feel
// different, but it is not intelligent. Use it to try the arena without an API key, to develop,
// and in CI. Swap in Jev (or Laya, kev, an LLM) for the real thing.

const STYLE_WORDS = {
  aggressive: /aggress|rush|relentless|berserk|pressure|never (back|retreat)|all[- ]in|hunt|chase/g,
  cautious: /cautious|patient|defens|careful|safe|turtle|wait for|counter/g,
  ranged: /distance|long range|snip|kite|keep away|stay far|poke/g,
  melee: /melee|punch|brawl|close range|fist|up close|grapple/g,
  heavy: /heavy shot|charge|big shot|blast|artillery/g,
  shield: /shield|block|guard/g,
  dash: /dash|dodge|evade|slippery|juke/g,
  powerup: /power-?up|repair|battery|overdrive|scaveng|collect|loot/g,
  cover: /cover|pillar|hide|behind/g,
};

function styleOf(text) {
  const t = text.toLowerCase();
  const out = {};
  for (const [k, re] of Object.entries(STYLE_WORDS)) out[k] = Math.min(2, (t.match(re) || []).length);
  return out;
}

const num = (s) => {
  const m = String(s ?? '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};

function readSituation(state) {
  const s = state?.situation || {};
  const me = s.me || {};
  const en = s.enemy || {};
  const inc = s.incoming || {};
  const pus = s.powerups || [];
  const nearest = pus.slice().sort((a, b) => num(a.my_distance) - num(b.my_distance))[0];
  return {
    hp: num(me.health),
    energy: num(me.energy),
    inCover: !!me.in_cover,
    dist: num(en.distance),
    los: !!en.line_of_sight,
    enemyHp: num(en.health),
    enemyCharging: String(en.charging_heavy_shot || '').startsWith('YES'),
    enemyShield: !!en.shield_up,
    enemyStunned: !!en.stunned,
    enemyStill: en.movement === 'standing still',
    bolts: num(inc.bolts_on_target),
    heavyIncoming: !!inc.heavy_shot_on_target,
    powerup: nearest ? { type: nearest.type, mine: num(nearest.my_distance), theirs: num(nearest.enemy_distance) } : null,
    timeLeft: num(s.time_left),
    outside: /OUTSIDE/.test(String(s.closing_zone || '')),
    closing: /^closing/.test(String(s.closing_zone || '')),
  };
}

function utilities(options, s, st, notes) {
  const u = {};
  const ranged = st.ranged + st.cover * 0.5;
  for (const o of options) {
    let x = 0;
    switch (o) {
      case 'advance':
        x = 0.2 + (s.dist > 6 ? 0.4 : 0) + st.aggressive * 0.5 + st.melee * 0.4 - st.cautious * 0.25 - ranged * 0.3 - (s.dist < 2 ? 0.6 : 0);
        break;
      case 'retreat':
        x = 0.05 + (s.hp < 35 ? 0.4 : 0) + (ranged > 0 && s.dist < 5 ? 0.7 : 0) + st.cautious * 0.15 - st.aggressive * 0.4;
        break;
      case 'strafe_left':
      case 'strafe_right':
        x = 0.25 + (s.bolts > 0 ? 0.6 : 0) + ranged * 0.25 + st.dash * 0.1 + ((o === 'strafe_left') === s.timeLeft % 6 < 3 ? 0.08 : 0);
        break;
      case 'shoot':
        x = 0.45 + (s.los ? 0.5 + st.cautious * 0.2 : -1.2) + ranged * 0.35 + (s.dist >= 3 && s.dist <= 9 ? 0.2 : 0) - (s.dist > 11 ? 0.25 : 0);
        break;
      case 'charge':
        x = 0.05 + st.heavy * 0.55 + (s.los && s.dist > 3 ? 0.3 : -0.6) + (s.enemyStunned ? 0.8 : 0) + (s.enemyStill ? 0.3 : 0) - (s.bolts > 0 ? 0.3 : 0);
        break;
      case 'shield':
        x = (s.enemyCharging ? 0.9 : 0) + (s.heavyIncoming ? 1.3 : 0) + (s.bolts > 0 ? 0.45 : -0.3) + st.shield * 0.35 + st.cautious * 0.2 - (s.dist < 2 ? 0.8 : 0);
        break;
      case 'dash':
        x = -0.2 + (s.heavyIncoming ? 1.1 : 0) + (s.bolts > 1 ? 0.35 : 0) + st.dash * 0.5;
        break;
      case 'melee':
        x = 0.3 + st.melee * 0.8 + st.aggressive * 0.4 + (s.enemyShield ? 0.7 : 0) + (s.enemyCharging ? 0.6 : 0);
        break;
      case 'take_cover':
        x = -0.1 + st.cautious * 0.35 + st.cover * 0.35 + (s.hp < 30 ? 0.35 : 0) + (s.enemyCharging && !s.inCover ? 0.45 : 0) - (s.inCover ? 0.7 : 0) - (s.hp > 70 ? 0.3 : 0);
        break;
      case 'grab_powerup':
        x = s.powerup
          ? 0.1 + st.powerup * 0.6 + (s.powerup.mine < s.powerup.theirs ? 0.4 : -0.3) + (s.powerup.type === 'repair' && s.hp < 55 ? 0.6 : 0)
          : -2;
        break;
      case 'go_center':
        x = s.outside ? 2.5 : s.closing ? 0.1 : -0.5;
        break;
      case 'wait':
        x = 0.05 + (s.energy < 20 ? 0.8 : 0) + (!s.los ? 0.9 : 0) + st.cautious * 0.1;
        break;
      case 'recharge':
        x = (s.energy < 25 ? 0.7 : -0.4) + (s.inCover ? 0.45 : -0.35) + (s.dist > 9 ? 0.2 : 0);
        break;
      default:
        x = 0;
    }
    // Nobody in sight: peek around the pillar instead of waiting forever.
    if (!s.los && (o === 'strafe_left' || o === 'strafe_right')) x += 0.35;
    if (!s.los && o === 'advance') x += 0.25 + st.aggressive * 0.3;
    if (notes.has(o)) x += 0.25;
    u[o] = x;
  }
  return u;
}

function softmax(u, temperature) {
  const keys = Object.keys(u);
  const max = Math.max(...keys.map((k) => u[k]));
  const exps = keys.map((k) => Math.exp((u[k] - max) / temperature));
  const total = exps.reduce((a, b) => a + b, 0);
  const out = {};
  keys.forEach((k, i) => (out[k] = exps[i] / total));
  return out;
}

const REFLEX_RULES = [
  { re: /charg|heavy shot|big shot|blast/, p: (s) => (s.enemyCharging || s.heavyIncoming ? 0.93 : 0.06) },
  { re: /(bolt|shot|projectile)s?.{0,20}(coming|incoming|about to hit|flying)|incoming/, p: (s) => (s.bolts > 0 || s.heavyIncoming ? 0.88 : 0.07) },
  { re: /(enemy|opponent|they|their).{0,40}(low|critical|almost dead|badly hurt|weak)|(low|critical).{0,20}(enemy|opponent)/, p: (s) => (s.enemyHp < 30 ? 0.9 : s.enemyHp < 45 ? 0.45 : 0.06) },
  { re: /(my|i am|i'm|i have).{0,30}(low|critical|dying|badly hurt|almost dead)|(health|hp).{0,10}(is )?(low|critical)/, p: (s) => (s.hp < 30 ? 0.9 : s.hp < 45 ? 0.4 : 0.05) },
  { re: /(enemy|opponent).{0,30}shield|shield.{0,10}(is )?up/, p: (s) => (s.enemyShield ? 0.9 : 0.06) },
  { re: /melee range|within reach|next to|adjacent|very close|up close|point blank/, p: (s) => (s.dist < 2.2 ? 0.9 : s.dist < 3.5 ? 0.45 : 0.04) },
  { re: /far away|long range|very far/, p: (s) => (s.dist > 9 ? 0.85 : 0.1) },
  { re: /power-?up|repair|battery|overdrive/, p: (s) => (s.powerup ? (s.powerup.mine < s.powerup.theirs ? 0.86 : 0.35) : 0.02) },
  { re: /energy.{0,20}(low|empty|out)|(low|no|out of) energy/, p: (s) => (s.energy < 25 ? 0.9 : 0.07) },
  { re: /no line of sight|behind (a )?pillar|in cover|hidden|can'?t see/, p: (s) => (!s.los ? 0.86 : 0.08) },
  { re: /stunned|dazed/, p: (s) => (s.enemyStunned ? 0.92 : 0.04) },
];

function reflexProbability(text, s) {
  const t = text.toLowerCase();
  let p = 1;
  let matched = 0;
  for (const rule of REFLEX_RULES) {
    if (rule.re.test(t)) {
      p *= rule.p(s);
      matched += 1;
      if (matched >= 2) break;
    }
  }
  return matched ? Math.max(0.01, Math.min(0.99, p)) : 0.3;
}

export function mockAnswer(request) {
  const s = readSituation(request.state);
  const answers = {};
  let inputChars = JSON.stringify(request).length;
  for (const [name, q] of Object.entries(request.questions || {})) {
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria || {});
      const notes = new Set(options.filter((o) => /Coach's note/.test(String(q.criteria[o] || ''))));
      const style = styleOf(q.instructions || '');
      const probabilities = softmax(utilities(options, s, style, notes), 0.35);
      let choice = options[0];
      for (const o of options) if (probabilities[o] > probabilities[choice]) choice = o;
      const ps = Object.values(probabilities).filter((p) => p > 0);
      let h = 0;
      for (const p of ps) h -= p * Math.log(p);
      const confidence = options.length > 1 ? Math.max(0, 1 - h / Math.log(options.length)) : 1;
      answers[name] = { type: 'choice', choice, probabilities, confidence };
    } else if (q.type === 'noul') {
      const text = String(q.instructions || '').replace(/^.*Is this true right now:\s*/i, '');
      answers[name] = { type: 'noul', noul: reflexProbability(text, s) };
    } else if (q.type === 'score') {
      const n = (q.criteria || []).length || 2;
      answers[name] = { type: 'score', score: (n - 1) / 2, probabilities: {}, confidence: 0 };
    }
  }
  return { model: 'mock', answers, usage: { input_tokens: Math.round(inputChars / 4), output_tokens: 0 } };
}

export function createMockBrain({ id = 'mock', label = 'Mock brain (offline heuristics)', latencyMs = [40, 120] } = {}) {
  const [lo, hi] = latencyMs;
  return {
    id,
    label,
    kind: 'mock',
    model: 'mock',
    async decide(request) {
      const started = now();
      const wait = lo + Math.random() * (hi - lo);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const response = mockAnswer(request);
      return { response, latencyMs: Math.round(now() - started) };
    },
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
