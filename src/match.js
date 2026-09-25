import * as C from './engine/constants.js';
import { createWorld, applyDecision, step } from './engine/world.js';
import { availableActions } from './engine/actions.js';
import { observe } from './engine/observe.js';
import { buildRequest, resolveDecision } from './protocol.js';

// Runs one fight between two fighters, each piloted by a brain.
//
// mode 'realtime': the world ticks at 20 Hz no matter what. A brain is asked again as soon as it
//   answers (at most every 150 ms). Slow brains simply act less often. This is the honest mode.
// mode 'lockstep': the world pauses every 4 ticks (0.2 s) until both brains answer. Speed stops
//   mattering, so it compares decision quality only.
//
// Every applied decision is recorded with the tick it landed on. Seed + decisions reproduce the
// whole fight, which is what replays are.

export class Match {
  constructor({ fighters, brains, seed = Math.floor(Math.random() * 1e9), mode = 'realtime', lockstepEvery = C.LOCKSTEP_EVERY_TICKS }) {
    this.fighters = fighters;
    this.brains = brains;
    this.seed = seed;
    this.mode = mode;
    this.lockstepEvery = lockstepEvery;
    this.world = createWorld({ seed, names: fighters.map((f) => f.name) });
    this.inbox = [];
    this.pending = [null, null];
    this.lastAskTick = [-1e9, -1e9];
    this.stopped = false;
    this.fatal = null;
    this.listeners = {};
    this.stats = [0, 1].map(() => ({ calls: 0, errors: 0, latencies: [], tokens: 0, reflexFires: 0, fallbacks: 0 }));
    this.replay = {
      format: 'jev-arena-replay',
      version: 2,
      engine: C.ENGINE_VERSION,
      seed,
      mode,
      createdAt: new Date().toISOString(),
      fighters,
      brains: brains.map((b) => ({ id: b.id, label: b.label, kind: b.kind, model: b.model })),
      decisions: [],
      result: null,
      summary: null,
    };
  }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.listeners[event] || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  }

  canAsk(side) {
    const f = this.world.fighters[side];
    return !this.world.over && !this.pending[side] && f.stunTicks === 0 && f.dashTicks === 0;
  }

  ask(side) {
    const fighter = this.fighters[side];
    const brain = this.brains[side];
    const available = availableActions(this.world, side);
    const observation = observe(this.world, side);
    const request = buildRequest({ fighter, observation, available, model: brain.model });
    const askedTick = this.world.tick;
    this.lastAskTick[side] = askedTick;
    this.stats[side].calls += 1;
    this.emit('ask', { side, tick: askedTick });
    const p = brain
      .decide(request)
      .then(
        ({ response, latencyMs }) => ({
          side,
          askedTick,
          latencyMs,
          usage: response?.usage,
          observation,
          available,
          decision: resolveDecision({ fighter, response, available }),
        }),
        (error) => ({ side, askedTick, error, latencyMs: null }),
      )
      .then((r) => {
        this.pending[side] = null;
        this.inbox.push(r);
        return r;
      });
    this.pending[side] = p;
    return p;
  }

  applyInbox() {
    const items = this.inbox.splice(0).sort((a, b) => a.side - b.side);
    for (const r of items) {
      const st = this.stats[r.side];
      if (r.error) {
        st.errors += 1;
        this.emit('brainError', { side: r.side, error: r.error, tick: this.world.tick });
        if (r.error.fatal) {
          this.fatal = r.error;
          this.stop();
        }
        continue;
      }
      const d = r.decision;
      const applied = applyDecision(this.world, r.side, d.move.action, d.act.action);
      st.latencies.push(r.latencyMs);
      st.tokens += r.usage?.input_tokens || 0;
      st.reflexFires += [d.move, d.act].filter((x) => x.source.startsWith('reflex')).length;
      if (d.move.source.startsWith('fallback')) st.fallbacks += 1;
      const rec = {
        t: this.world.tick,
        s: r.side,
        m: d.move.action,
        x: d.act.action,
        src: d.move.source,
        xsrc: d.act.source,
        c: round3(d.move.confidence),
        xc: round3(d.act.confidence),
        p: compactProbs(d.move.probabilities),
        xp: compactProbs(d.act.probabilities),
        r: d.reflexes.map((x) => (x.p === null ? null : round3(x.p))),
        ms: r.latencyMs,
        at: r.askedTick,
        ok: applied,
      };
      this.replay.decisions.push(rec);
      this.emit('decision', { ...rec, decision: d, observation: r.observation, available: r.available });
    }
  }

  tick() {
    this.world.events = [];
    this.applyInbox();
    if (this.stopped) return;
    step(this.world);
    this.emit('tick', this.world);
    if (this.world.over) this.finish();
  }

  stop() {
    this.stopped = true;
  }

  finish() {
    if (this.replay.result) return;
    this.replay.result = this.world.result;
    this.replay.summary = this.summary();
    this.emit('end', this.replay);
  }

  summary() {
    return this.stats.map((st, side) => {
      const lat = [...st.latencies].sort((a, b) => a - b);
      const brain = this.brains[side];
      const cost = brain.pricePerMillion != null ? (st.tokens / 1e6) * brain.pricePerMillion : null;
      const f = this.world.fighters[side];
      return {
        decisions: st.latencies.length,
        errors: st.errors,
        p50LatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
        avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        decisionsPerSecond: round3(st.latencies.length / Math.max(1, this.world.tick / C.TICK_HZ)),
        inputTokens: st.tokens,
        costUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
        reflexFires: st.reflexFires,
        fallbacks: st.fallbacks,
        stats: f.stats,
      };
    });
  }

  // Real-time loop. Resolves with the replay when the fight ends or is stopped.
  runRealtime({ timeScale = 1 } = {}) {
    const tickMs = 1000 / C.TICK_HZ / timeScale;
    const minGap = C.secondsToTicks(C.MIN_DECISION_INTERVAL_S);
    let next = now();
    return new Promise((resolve) => {
      const loop = () => {
        if (this.stopped || this.world.over) {
          if (!this.world.over) this.emit('stopped', this.fatal);
          return resolve(this.replay);
        }
        for (const side of [0, 1]) {
          if (this.canAsk(side) && this.world.tick - this.lastAskTick[side] >= minGap) this.ask(side);
        }
        this.tick();
        next += tickMs;
        setTimeout(loop, Math.max(0, next - now()));
      };
      loop();
    });
  }

  // Lockstep loop. With paced=true the world still plays at real speed between decision points
  // (good for watching); with paced=false it runs as fast as the brains answer (good for ladders).
  async runLockstep({ paced = false } = {}) {
    const tickMs = 1000 / C.TICK_HZ;
    let next = now();
    while (!this.world.over && !this.stopped) {
      if (this.world.tick % this.lockstepEvery === 0) {
        const asks = [];
        for (const side of [0, 1]) if (this.canAsk(side)) asks.push(this.ask(side));
        if (asks.length) {
          await Promise.all(asks);
          next = now();
        }
      }
      this.tick();
      if (paced) {
        next += tickMs;
        const wait = next - now();
        if (wait > 0) await sleep(wait);
      } else if (this.world.tick % 40 === 0) {
        await sleep(0);
      }
    }
    if (!this.world.over) this.emit('stopped', this.fatal);
    return this.replay;
  }

  run(opts = {}) {
    return this.mode === 'lockstep' ? this.runLockstep(opts) : this.runRealtime(opts);
  }
}

function compactProbs(p) {
  const out = {};
  for (const [k, x] of Object.entries(p || {})) if (x >= 0.005) out[k] = round3(x);
  return out;
}

const round3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
