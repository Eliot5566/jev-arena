import { createWorld, applyDecision, step } from './engine/world.js';
import { MATCH_TICKS } from './engine/constants.js';

// Re-simulate a recorded fight from its seed and decision log. Because the engine only uses
// seeded randomness and exact float operations, this reproduces the original fight tick for tick.

export function createReplayer(replay) {
  const world = createWorld({ seed: replay.seed, names: replay.fighters.map((f) => f.name) });
  const byTick = new Map();
  for (const d of replay.decisions) {
    if (!byTick.has(d.t)) byTick.set(d.t, []);
    byTick.get(d.t).push(d);
  }
  return {
    world,
    // Advance one tick. Returns the decisions that landed on it.
    next() {
      if (world.over || world.tick > MATCH_TICKS + 1) return null;
      world.events = [];
      const ds = (byTick.get(world.tick) || []).slice().sort((a, b) => a.s - b.s);
      for (const d of ds) applyDecision(world, d.s, d.m ?? d.a, d.x ?? null);
      step(world);
      return ds;
    },
  };
}

export function verifyReplay(replay) {
  const r = createReplayer(replay);
  while (r.next() !== null) {}
  const got = r.world.result;
  const want = replay.result;
  const same = !!got && !!want && got.winner === want.winner && got.reason === want.reason && got.tick === want.tick && got.hp.join() === want.hp.join();
  return { ok: same, got, want };
}
