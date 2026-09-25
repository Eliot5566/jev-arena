import * as C from './constants.js';
import { sub, dot, dist, norm, round } from './vec.js';
import { hasLineOfSight, coverPoint, zoneAt, zoneMargin } from './world.js';

// Turn raw world state into what a fighter "sees": short, named, pre-digested facts.
// System One models judge well when the state is semantic ("enemy is charging a heavy shot,
// fires in 0.4s") and badly when they have to do geometry, so the arithmetic happens here.

const health = (hp) => (hp >= 75 ? 'healthy' : hp >= 45 ? 'wounded' : hp >= 20 ? 'badly hurt' : 'critical');
const energyLevel = (e) => (e >= 70 ? 'high' : e >= 35 ? 'medium' : e >= 15 ? 'low' : 'empty');
const range = (d) => (d <= C.MELEE.range ? 'melee range' : d <= 4 ? 'close' : d <= 9 ? 'medium' : 'far');
const secs = (ticks) => `${round(ticks / C.TICK_HZ, 1)}s`;

function motion(f, other) {
  const speed = Math.sqrt(dot(f.move, f.move)) / C.DT;
  if (speed < 0.4) return 'standing still';
  const toOther = norm(sub(other, f));
  const along = dot(norm(f.move), toOther);
  if (along > 0.5) return 'coming toward me';
  if (along < -0.5) return 'moving away from me';
  return 'moving sideways';
}

function readiness(ticks, ready = 'ready') {
  return ticks > 0 ? `recharging (${secs(ticks)})` : ready;
}

function incomingThreats(world, me) {
  let bolts = 0;
  let heavy = false;
  let soonest = null;
  for (const p of world.projectiles) {
    if (p.owner === me.side) continue;
    const rel = sub(me, p);
    const vv = dot(p.vel, p.vel);
    const t = dot(rel, p.vel) / vv;
    if (t <= 0) continue;
    const cx = p.x + p.vel.x * t - me.x;
    const cy = p.y + p.vel.y * t - me.y;
    const miss = Math.sqrt(cx * cx + cy * cy);
    if (miss > C.FIGHTER_RADIUS + p.r + 0.25) continue;
    if (p.kind === 'blast') heavy = true;
    else bolts += 1;
    if (soonest === null || t < soonest) soonest = t;
  }
  return { bolts, heavy, soonest };
}

function zoneReport(world, me) {
  const t = world.tick / C.TICK_HZ;
  if (t < C.ZONE.startAt - 5) return `not yet (starts closing at ${C.ZONE.startAt}s)`;
  const z = zoneAt(world.tick);
  if (!z.closing) return `starts closing in ${Math.ceil(C.ZONE.startAt - t)}s`;
  const m = zoneMargin(me, z);
  const size = `${round(z.x1 - z.x0, 0)}x${round(z.y1 - z.y0, 0)}m around the center`;
  return m >= 0
    ? `closing, safe area ${size}; I am inside, ${round(m, 1)}m from the edge`
    : `closing, safe area ${size}; I am OUTSIDE and losing ${C.ZONE.dps} health per second, ${round(-m, 1)}m from safety`;
}

export function observe(world, side) {
  const me = world.fighters[side];
  const enemy = world.fighters[1 - side];
  const d = dist(me, enemy);
  const los = hasLineOfSight(me, enemy);
  const threats = incomingThreats(world, me);
  const cover = coverPoint(world, side);

  const myHeavy =
    me.chargeTicks > 0
      ? `charging, fires in ${secs(me.chargeTicks)}`
      : me.cd.charge > 0
        ? readiness(me.cd.charge)
        : me.energy < C.BLAST.cost
          ? 'not enough energy'
          : 'ready';

  const lead = Math.round(me.hp) - Math.round(enemy.hp);

  return {
    time_left: `${Math.max(0, Math.ceil((C.MATCH_TICKS - world.tick) / C.TICK_HZ))}s`,
    me: {
      health: `${Math.round(me.hp)}/100 (${health(me.hp)})`,
      energy: `${Math.round(me.energy)}/100 (${energyLevel(me.energy)})`,
      shield: me.shieldTicks > 0 ? 'UP' : readiness(me.cd.shield),
      dash: me.dashTicks > 0 ? 'dashing' : readiness(me.cd.dash),
      heavy_shot: myHeavy,
      in_cover: !los,
      near_wall: me.x < 1.5 || me.x > C.ARENA_W - 1.5 || me.y < 1.5 || me.y > C.ARENA_H - 1.5,
      overdrive: me.overdriveTicks > 0 ? `active (${secs(me.overdriveTicks)})` : 'no',
      current_movement: me.intent,
    },
    enemy: {
      name: enemy.name,
      distance: `${round(d, 1)}m (${range(d)})`,
      line_of_sight: los,
      health: `${Math.round(enemy.hp)}/100 (${health(enemy.hp)})`,
      energy: energyLevel(enemy.energy),
      charging_heavy_shot: enemy.chargeTicks > 0 ? `YES, fires in ${secs(enemy.chargeTicks)}` : 'no',
      shield_up: enemy.shieldTicks > 0,
      stunned: enemy.stunTicks > 0,
      movement: motion(enemy, me),
      overdrive: enemy.overdriveTicks > 0,
    },
    incoming: {
      bolts_on_target: threats.bolts,
      heavy_shot_on_target: threats.heavy,
      first_impact_in: threats.soonest === null ? 'none' : `${round(threats.soonest, 2)}s`,
    },
    powerups: world.powerups.map((p) => ({
      type: p.type,
      my_distance: `${round(dist(me, p), 1)}m`,
      enemy_distance: `${round(dist(enemy, p), 1)}m`,
    })),
    nearest_cover: `${round(dist(me, cover), 1)}m away`,
    closing_zone: zoneReport(world, me),
    recent_moves: { mine: [...me.lastActions], enemy: [...enemy.lastActions] },
    scoreboard: lead > 0 ? `I lead by ${lead} health` : lead < 0 ? `I trail by ${-lead} health` : 'even',
  };
}
