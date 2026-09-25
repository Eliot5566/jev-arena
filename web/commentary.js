// Rule-based live commentary for streams. It reads the same things the viewer sees (engine events,
// health, each decision's probabilities) and turns the interesting moments into short lines.
// Jev's probabilities are calibrated, so "91% sure" is a real number worth saying out loud.
//
// Names are emitted as tokens (⟦0⟧ / ⟦1⟧) so the caller can color them; plain() swaps in names.

import { t, moveLabel } from './i18n.js';

const TICK_HZ = 20;
const A = '⟦0⟧';
const B = '⟦1⟧';
const who = (side) => (side === 0 ? A : B);

export function createCommentator({ fighters, brainLabel = '', mode = 'realtime' }) {
  const s = {
    lastLine: -1e9,
    lastSoft: -1e9,
    lastDamage: null,
    lullSaid: false,
    leader: null,
    ropes: [false, false],
    burning: [false, false],
    zoneSaid: false,
    reflexAt: new Map(),
    softAt: [-1e9, -1e9],
    lastDecision: [null, null],
    ended: false,
  };

  // level: 'big' always shows; 'normal' needs 0.8s of quiet; 'soft' needs 3s of quiet.
  function line(tick, text, level = 'normal') {
    const quiet = level === 'big' ? 0 : level === 'normal' ? 0.8 * TICK_HZ : 3 * TICK_HZ;
    if (tick - s.lastLine < quiet) return null;
    s.lastLine = tick;
    if (level === 'soft') s.lastSoft = tick;
    return { tick, text, level };
  }

  return {
    plain(text) {
      return text.replaceAll(A, fighters[0].name).replaceAll(B, fighters[1].name);
    },

    intro() {
      const modeName = mode === 'lockstep' ? t('setup.lockstep') : t('setup.realtime');
      return { tick: 0, text: t('cc.intro', { a: A, b: B, mode: modeName.toLowerCase(), brain: brainLabel }), level: 'big' };
    },

    // One decision from either fighter. Returns a line or null.
    decision(d) {
      s.lastDecision[d.s] = d;
      const f = fighters[d.s];
      for (const [src, action] of [
        [d.src, d.m],
        [d.xsrc, d.x],
      ]) {
        if (!src || !src.startsWith('reflex')) continue;
        const i = Number(src.split(' ')[1]) - 1;
        const r = f.reflexes?.[i];
        if (!r) continue;
        const key = `${d.s}:${i}`;
        if (d.t - (s.reflexAt.get(key) ?? -1e9) < 6 * TICK_HZ) return null;
        const out = line(d.t, t('cc.reflex', { a: who(d.s), p: Math.round((d.r?.[i] ?? 0) * 100), when: r.when.replace(/\.$/, ''), move: moveLabel(action) }));
        if (out) s.reflexAt.set(key, d.t);
        return out;
      }
      if (d.t - s.softAt[d.s] < 8 * TICK_HZ) return null;
      const acting = d.x && d.x !== 'wait';
      if (acting && (d.xc ?? 0) >= 0.9 && (d.xp?.[d.x] ?? 0) >= 0.85) {
        const out = line(d.t, t('cc.sure', { a: who(d.s), p: Math.round(d.xp[d.x] * 100), move: moveLabel(d.x) }), 'soft');
        if (out) s.softAt[d.s] = d.t;
        return out;
      }
      const probs = Object.values(d.p || {});
      if (probs.length >= 3 && Math.max(...probs) < 0.35) {
        const out = line(d.t, t('cc.unsure', { a: who(d.s), p: Math.round(Math.max(...probs) * 100) }), 'soft');
        if (out) s.softAt[d.s] = d.t;
        return out;
      }
      return null;
    },

    // Everything that happened on one engine tick. Returns a list of lines (usually empty).
    tick(world) {
      const out = [];
      const push = (l) => l && out.push(l);
      const hp = world.fighters.map((f) => Math.max(0, f.hp));
      for (const e of world.events) {
        switch (e.type) {
          case 'blast': {
            const other = 1 - e.side;
            const d = s.lastDecision[other];
            const read = d ? Math.max(d.xp?.dash ?? 0, d.xp?.shield ?? 0) : 0;
            push(read >= 0.5 ? line(e.tick, t('cc.blastRead', { a: who(e.side), b: who(other), p: Math.round(read * 100) })) : line(e.tick, t('cc.blast', { a: who(e.side) })));
            break;
          }
          case 'hit':
            if (e.amount >= 0.5) {
              s.lastDamage = e.tick;
              s.lullSaid = false;
            }
            if (e.kind === 'blast' && e.amount >= 5) push(line(e.tick, t('cc.blastHit', { b: who(e.target), n: Math.round(e.amount) }), 'big'));
            break;
          case 'blocked':
            if (e.amount >= 10) push(line(e.tick, t('cc.shieldBig', { b: who(e.side), n: Math.round(e.amount) })));
            break;
          case 'guard_break':
            push(line(e.tick, t('cc.guardBreak', { a: who(e.side) }), 'big'));
            break;
          case 'dodge':
            push(line(e.tick, t('cc.dodge', { a: who(e.side) })));
            break;
          case 'pickup':
            if (e.kind === 'overdrive') push(line(e.tick, t('cc.overdrive', { a: who(e.side) }), 'big'));
            else if (e.kind === 'repair') push(line(e.tick, t('cc.repair', { a: who(e.side) })));
            else push(line(e.tick, t('cc.battery', { a: who(e.side) }), 'soft'));
            break;
          case 'zone_start':
            if (!s.zoneSaid) push(line(e.tick, t('cc.zone'), 'big'));
            s.zoneSaid = true;
            break;
          case 'zone_burn':
            if (!s.burning[e.side]) {
              const l = line(e.tick, t('cc.burning', { a: who(e.side) }));
              if (l) s.burning[e.side] = true;
              push(l);
            }
            break;
          case 'ko':
            s.ended = true;
            s.lastLine = -1e9;
            push(
              e.reason === 'ko'
                ? line(e.tick, t('cc.ko', { a: who(e.side), hp: Math.round(hp[e.side]) }), 'big')
                : line(e.tick, t('cc.time', { a: who(e.side), x: Math.round(hp[e.side]), y: Math.round(hp[1 - e.side]) }), 'big'),
            );
            break;
          case 'draw':
            s.ended = true;
            s.lastLine = -1e9;
            push(line(e.tick, t('cc.draw'), 'big'));
            break;
          default:
        }
      }
      if (s.ended) return out;

      // Momentum: a new leader once the gap is real.
      const gap = hp[0] - hp[1];
      const leader = gap >= 8 ? 0 : gap <= -8 ? 1 : s.leader;
      // Only mark a moment as said once its line actually got through the rate limit.
      if (leader !== null && leader !== s.leader) {
        const l = line(world.tick, t('cc.lead', { a: who(leader), x: Math.round(hp[leader]), y: Math.round(hp[1 - leader]) }));
        if (l) s.leader = leader;
        push(l);
      }
      for (const i of [0, 1]) {
        if (!s.ropes[i] && hp[i] > 0 && hp[i] < 25) {
          const l = line(world.tick, t('cc.ropes', { a: who(i), hp: Math.round(hp[i]) }));
          if (l) s.ropes[i] = true;
          push(l);
        }
      }
      if (s.lastDamage !== null && !s.lullSaid && world.tick - s.lastDamage >= 6 * TICK_HZ) {
        s.lullSaid = true;
        push(line(world.tick, t('cc.lull', { s: Math.round((world.tick - s.lastDamage) / TICK_HZ) }), 'soft'));
      }
      return out;
    },
  };
}
