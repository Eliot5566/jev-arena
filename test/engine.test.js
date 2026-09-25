import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, applyDecision, step, hasLineOfSight } from '../src/engine/world.js';
import { availableActions, ACTION_IDS } from '../src/engine/actions.js';
import { observe } from '../src/engine/observe.js';
import * as C from '../src/engine/constants.js';
import { Match } from '../src/match.js';
import { verifyReplay } from '../src/replay.js';
import { createMockBrain, mockAnswer } from '../src/brains/mock.js';
import { buildRequest, resolveDecision, confidenceOf } from '../src/protocol.js';
import { validateFighter, fighterToYaml } from '../src/fighter.js';
import { loadFighters } from '../src/node/fighters.js';
import { fromReply, toPrompt } from '../src/brains/llm.js';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fighters = Object.fromEntries(loadFighters(path.join(ROOT, 'fighters')).map((r) => [r.fighter.id, r.fighter]));
const instant = () => createMockBrain({ latencyMs: [0, 0] });

test('every bundled fighter is valid', () => {
  for (const r of loadFighters(path.join(ROOT, 'fighters'))) assert.ok(r.ok, `${r.file}: ${r.errors.join(', ')}`);
});

test('the map is point-symmetric so neither corner is favored', () => {
  const cx = C.ARENA_W / 2;
  const cy = C.ARENA_H / 2;
  const has = (list, x, y) => list.some((p) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
  for (const p of C.PILLARS) assert.ok(has(C.PILLARS, 2 * cx - p.x, 2 * cy - p.y));
  for (const p of C.POWERUP_PADS) assert.ok(has(C.POWERUP_PADS, 2 * cx - p.x, 2 * cy - p.y));
  assert.ok(has(C.SPAWNS, 2 * cx - C.SPAWNS[0].x, 2 * cy - C.SPAWNS[0].y));
});

test('a bolt fired in the open hits a standing target', () => {
  const w = createWorld({ seed: 1 });
  w.fighters[0].x = 4;
  w.fighters[0].y = 2;
  w.fighters[1].x = 9;
  w.fighters[1].y = 2;
  assert.ok(hasLineOfSight(w.fighters[0], w.fighters[1]));
  assert.ok(applyDecision(w, 0, null, 'shoot'));
  for (let i = 0; i < 20; i++) step(w);
  assert.equal(w.fighters[1].hp, C.MAX_HP - C.BOLT.dmg);
});

test('shields cut shot damage and melee breaks them', () => {
  const w = createWorld({ seed: 2 });
  Object.assign(w.fighters[0], { x: 4, y: 2 });
  Object.assign(w.fighters[1], { x: 9, y: 2 });
  applyDecision(w, 1, null, 'shield');
  applyDecision(w, 0, null, 'shoot');
  for (let i = 0; i < 12; i++) step(w);
  assert.ok(Math.abs(w.fighters[1].hp - (C.MAX_HP - C.BOLT.dmg * (1 - C.SHIELD.reduction))) < 1e-9);

  const w2 = createWorld({ seed: 3 });
  Object.assign(w2.fighters[0], { x: 4, y: 2 });
  Object.assign(w2.fighters[1], { x: 5.6, y: 2 });
  applyDecision(w2, 1, null, 'shield');
  assert.ok(availableActions(w2, 0).acts.includes('melee'));
  applyDecision(w2, 0, null, 'melee');
  assert.equal(w2.fighters[1].shieldTicks, 0);
  assert.ok(w2.fighters[1].stunTicks > 0);
  assert.equal(w2.fighters[1].hp, C.MAX_HP - C.MELEE.dmg);
});

test('dashing makes a fighter untouchable', () => {
  const w = createWorld({ seed: 4 });
  Object.assign(w.fighters[0], { x: 4, y: 2 });
  Object.assign(w.fighters[1], { x: 5.8, y: 2 });
  applyDecision(w, 0, 'strafe_left', 'shoot');
  applyDecision(w, 1, 'advance', 'dash');
  for (let i = 0; i < 10; i++) step(w);
  assert.equal(w.fighters[1].hp, C.MAX_HP);
});

test('unavailable moves are not offered', () => {
  const w = createWorld({ seed: 5 });
  w.fighters[0].energy = 0;
  const { moves, acts } = availableActions(w, 0);
  for (const m of ['shoot', 'charge', 'shield', 'dash']) assert.ok(!acts.includes(m));
  assert.ok(!acts.includes('melee'), 'enemy is far away');
  assert.deepEqual(acts, ['wait']);
  assert.ok(!moves.includes('grab_powerup'), 'no power-ups yet');
  assert.ok(moves.includes('recharge'));
});

test('observation is compact, semantic and JSON-safe', () => {
  const w = createWorld({ seed: 6 });
  const o = observe(w, 0);
  const text = JSON.stringify(o);
  assert.ok(text.length < 1400, `observation is ${text.length} chars`);
  assert.match(o.me.health, /100\/100 \(healthy\)/);
  assert.match(o.enemy.distance, /far/);
  assert.equal(o.enemy.charging_heavy_shot, 'no');
});

test('request uses only available moves and attaches reflexes as nouls', () => {
  const w = createWorld({ seed: 7 });
  const f = fighters.tortoise;
  const available = availableActions(w, 0);
  const req = buildRequest({ fighter: f, observation: observe(w, 0), available });
  assert.deepEqual(Object.keys(req.questions.move.criteria), available.moves);
  assert.deepEqual(Object.keys(req.questions.act.criteria), available.acts);
  assert.equal(req.questions.move.type, 'choice');
  assert.equal(req.questions.act.type, 'choice');
  assert.match(req.questions.act.criteria.shield, /Coach's note/);
  assert.match(req.questions.move.criteria.take_cover, /Coach's note/);
  assert.equal(req.questions.reflex_0.type, 'noul');
  assert.ok(!('reflex_1' in req.questions), 'grab_powerup reflex is skipped while no power-up exists');

  w.fighters[0].energy = 0;
  const bare = buildRequest({ fighter: f, observation: observe(w, 0), available: availableActions(w, 0) });
  assert.ok(!('act' in bare.questions), 'no act question when only "wait" is possible');
});

test('decision resolution: reflex > confident choice > fallback, for move and act separately', () => {
  const f = fighters.tortoise;
  const available = { moves: ['advance', 'retreat', 'strafe_left', 'take_cover'], acts: ['shoot', 'shield', 'wait'] };
  const base = {
    move: { type: 'choice', choice: 'strafe_left', probabilities: { strafe_left: 0.7, advance: 0.3 }, confidence: 0.5 },
    act: { type: 'choice', choice: 'shoot', probabilities: { shoot: 0.8, wait: 0.2 }, confidence: 0.6 },
  };
  let d = resolveDecision({ fighter: f, response: { answers: { ...base, reflex_0: { type: 'noul', noul: 0.95 } } }, available });
  assert.equal(d.act.action, 'shield');
  assert.equal(d.act.source, 'reflex 1');
  assert.equal(d.move.action, 'strafe_left', 'an action reflex leaves the movement alone');
  d = resolveDecision({ fighter: f, response: { answers: { ...base, reflex_0: { type: 'noul', noul: 0.3 } } }, available });
  assert.equal(d.act.action, 'shoot');
  assert.equal(d.move.source, 'strategy');
  d = resolveDecision({ fighter: f, response: { answers: { move: { ...base.move, confidence: 0.05 }, act: { ...base.act, confidence: 0.05 } } }, available });
  assert.equal(d.move.action, 'take_cover');
  assert.match(d.move.source, /fallback/);
  assert.equal(d.act.action, 'wait');
  d = resolveDecision({ fighter: f, response: {}, available });
  assert.equal(d.move.action, 'take_cover');
  assert.equal(d.act.action, 'wait');
});

test('confidence is 1 for a certain answer and 0 for a uniform one', () => {
  assert.equal(confidenceOf({ a: 1, b: 0, c: 0 }), 1);
  assert.ok(confidenceOf({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }) < 1e-9);
});

test('mock brain answers in the System One shape', () => {
  const w = createWorld({ seed: 8 });
  w.fighters[1].x = 6;
  const available = availableActions(w, 0);
  const res = mockAnswer(buildRequest({ fighter: fighters.berserker, observation: observe(w, 0), available }));
  const a = res.answers.move;
  assert.equal(a.type, 'choice');
  assert.ok(available.moves.includes(a.choice));
  assert.ok(available.acts.includes(res.answers.act.choice));
  const sum = Object.values(a.probabilities).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(a.confidence >= 0 && a.confidence <= 1);
  assert.ok(!('reflex_0' in res.answers), 'melee reflex is not asked while the enemy is out of reach');
  assert.ok(res.answers.reflex_1.noul >= 0 && res.answers.reflex_1.noul <= 1);
});

test('a full lockstep fight finishes and its replay re-simulates exactly', async () => {
  const m = new Match({ fighters: [fighters.sniper, fighters.trickster], brains: [instant(), instant()], seed: 42, mode: 'lockstep' });
  const replay = await m.run();
  assert.ok(replay.result, 'fight produced a result');
  assert.ok(replay.decisions.length > 20);
  assert.equal(replay.engine, C.ENGINE_VERSION);
  const v = verifyReplay(JSON.parse(JSON.stringify(replay)));
  assert.ok(v.ok, `replay diverged: ${JSON.stringify(v)}`);
});

test('same seed and same answers give the same fight', async () => {
  const run = () => new Match({ fighters: [fighters.berserker, fighters.tortoise], brains: [instant(), instant()], seed: 9, mode: 'lockstep' }).run();
  const [a, b] = await Promise.all([run(), run()]);
  assert.deepEqual(a.result, b.result);
  assert.equal(a.decisions.length, b.decisions.length);
});

test('a fatal brain error stops the fight instead of hanging', async () => {
  const broken = { id: 'broken', label: 'broken', decide: async () => { const e = new Error('401 bad key'); e.fatal = true; throw e; } };
  const m = new Match({ fighters: [fighters.zen, fighters.sniper], brains: [broken, instant()], seed: 1, mode: 'lockstep' });
  await m.run();
  assert.ok(m.fatal);
  assert.equal(m.replay.result, null);
});

test('fighter validation catches bad input', () => {
  const { ok, errors } = validateFighter({ name: '', strategy: 'short', reflexes: [{ when: 'x', do: 'fly', threshold: 2 }], fallback: 'shoot' });
  assert.ok(!ok);
  const text = errors.join(' | ');
  for (const needle of ['name is required', 'author is required', 'strategy must be at least', 'reflexes[0].do', 'threshold', 'fallback must be a movement']) assert.ok(text.includes(needle), needle);
});

test('Fighter Lab YAML round-trips through the YAML parser', () => {
  for (const f of Object.values(fighters)) {
    const back = validateFighter(YAML.parse(fighterToYaml(f)), f.id);
    assert.ok(back.ok, back.errors.join(', '));
    assert.deepEqual(back.fighter, f);
  }
});

test('LLM adapter builds a prompt and parses a reply back into System One answers', () => {
  const w = createWorld({ seed: 10 });
  const available = availableActions(w, 0);
  const req = buildRequest({ fighter: fighters.tortoise, observation: observe(w, 0), available });
  const prompt = toPrompt(req);
  for (const a of available.moves) assert.ok(prompt.includes(`* ${a}:`));
  const reply = JSON.stringify({ move: { probabilities: { advance: 2, strafe_left: 6, retreat: 2 } }, act: { probabilities: { wait: 1 } }, reflex_0: { p: 0.85 } });
  const res = fromReply(req, '```json\n' + reply + '\n```');
  assert.equal(res.answers.move.choice, 'strafe_left');
  assert.ok(Math.abs(res.answers.move.probabilities.strafe_left - 0.6) < 1e-9);
  assert.equal(res.answers.reflex_0.noul, 0.85);
  assert.ok(ACTION_IDS.includes(res.answers.move.choice));
});

test('the closing zone burns fighters outside it and ends in open ground', async () => {
  const { zoneAt, insideZone } = await import('../src/engine/world.js');
  const early = zoneAt(C.secondsToTicks(C.ZONE.startAt - 1));
  assert.equal(early.closing, false);
  const final = zoneAt(C.secondsToTicks(C.ZONE.endAt + 1));
  assert.ok(Math.abs(final.x1 - final.x0 - C.ZONE.minW) < 1e-9);
  for (const p of C.PILLARS) {
    const clear = p.x + p.r <= final.x0 || p.x - p.r >= final.x1 || p.y + p.r <= final.y0 || p.y - p.r >= final.y1;
    assert.ok(clear, 'no pillar inside the final zone');
  }
  const w = createWorld({ seed: 11 });
  w.tick = C.secondsToTicks(C.ZONE.endAt);
  Object.assign(w.fighters[0], { x: 1, y: 1 });
  Object.assign(w.fighters[1], { x: 12, y: 7 });
  assert.ok(!insideZone(w.fighters[0], zoneAt(w.tick)));
  for (let i = 0; i < C.TICK_HZ; i++) step(w);
  assert.ok(Math.abs(w.fighters[0].hp - (C.MAX_HP - C.ZONE.dps)) < 1e-6);
  assert.equal(w.fighters[1].hp, C.MAX_HP);
});
