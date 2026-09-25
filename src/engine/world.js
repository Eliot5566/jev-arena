import * as C from './constants.js';
import { createRng } from './rng.js';
import { v, add, sub, mul, dot, dist, norm, perp, segmentHitsCircle } from './vec.js';
import { isMovement } from './actions.js';

const T = C.secondsToTicks;
const FR = C.FIGHTER_RADIUS;

function makeFighter(side, spawn, name) {
  return {
    side,
    name,
    x: spawn.x,
    y: spawn.y,
    face: v(side === 0 ? 1 : -1, 0),
    move: v(0, 0),
    hp: C.MAX_HP,
    energy: C.MAX_ENERGY,
    intent: 'hold',
    lastActions: [],
    shieldTicks: 0,
    chargeTicks: 0,
    dashTicks: 0,
    dashDir: v(0, 0),
    stunTicks: 0,
    knockTicks: 0,
    knockVel: v(0, 0),
    overdriveTicks: 0,
    cd: { shoot: 0, charge: 0, shield: 0, dash: 0, melee: 0 },
    stats: {
      damageDealt: 0,
      damageTaken: 0,
      shots: 0,
      hits: 0,
      blasts: 0,
      blastHits: 0,
      melees: 0,
      meleeHits: 0,
      blocked: 0,
      dodges: 0,
      pickups: 0,
      zoneDamage: 0,
      decisions: 0,
    },
  };
}

export function createWorld({ seed = 1, names = ['Red', 'Blue'] } = {}) {
  return {
    tick: 0,
    seed,
    rng: createRng(seed),
    fighters: C.SPAWNS.map((s, i) => makeFighter(i, s, names[i])),
    projectiles: [],
    powerups: [],
    events: [],
    nextId: 1,
    nextPowerupTick: T(C.POWERUP.firstAt),
    over: false,
    result: null,
  };
}

// ---------- geometry helpers shared with the observer ----------

export function hasLineOfSight(a, b) {
  for (const p of C.PILLARS) if (segmentHitsCircle(a, b, p, p.r)) return false;
  return true;
}

// The safe rectangle at a given tick (the whole arena until the zone starts closing).
export function zoneAt(tick) {
  const t = tick / C.TICK_HZ;
  const k = Math.max(0, Math.min(1, (t - C.ZONE.startAt) / (C.ZONE.endAt - C.ZONE.startAt)));
  const w = C.ARENA_W - (C.ARENA_W - C.ZONE.minW) * k;
  const h = C.ARENA_H - (C.ARENA_H - C.ZONE.minH) * k;
  const cx = C.ARENA_W / 2;
  const cy = C.ARENA_H / 2;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, closing: t >= C.ZONE.startAt };
}

export const insideZone = (p, z) => p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1;

// How far p is from the safe area's edge: positive inside, negative outside.
export function zoneMargin(p, z) {
  if (insideZone(p, z)) return Math.min(p.x - z.x0, z.x1 - p.x, p.y - z.y0, z.y1 - p.y);
  const dx = Math.max(z.x0 - p.x, 0, p.x - z.x1);
  const dy = Math.max(z.y0 - p.y, 0, p.y - z.y1);
  return -Math.sqrt(dx * dx + dy * dy);
}

export function coverPoint(world, side) {
  const me = world.fighters[side];
  const enemy = world.fighters[1 - side];
  const zone = zoneAt(world.tick);
  let best = null;
  let bestCost = Infinity;
  for (const p of C.PILLARS) {
    const away = norm(sub(p, enemy));
    const pt = clampToArena(add(p, mul(away, p.r + FR + 0.25)));
    const cost = dist(me, pt) + (insideZone(pt, zone) ? 0 : 50);
    if (cost < bestCost) {
      bestCost = cost;
      best = pt;
    }
  }
  return best;
}

export function nearestPowerup(world, pos) {
  let best = null;
  let bd = Infinity;
  for (const pu of world.powerups) {
    const d = dist(pos, pu);
    if (d < bd) {
      bd = d;
      best = pu;
    }
  }
  return best;
}

function clampToArena(p) {
  return v(Math.min(C.ARENA_W - FR, Math.max(FR, p.x)), Math.min(C.ARENA_H - FR, Math.max(FR, p.y)));
}

const od = (f) => (f.overdriveTicks > 0 ? C.POWERUP.overdriveMult : 1);

function emit(world, type, side, extra = {}) {
  world.events.push({ tick: world.tick, type, side, ...extra });
}

function damage(world, attacker, target, amount, kind) {
  const dealt = Math.min(target.hp, amount);
  target.hp -= dealt;
  target.stats.damageTaken += dealt;
  attacker.stats.damageDealt += dealt;
  emit(world, 'hit', attacker.side, { target: target.side, amount: dealt, kind, x: target.x, y: target.y });
}

// ---------- decisions ----------

// Apply one brain decision to one fighter: a movement plus an action (or "wait").
// Decisions arrive between ticks. Anything that is no longer legal (the world changed while
// the brain was thinking) quietly fizzles. Returns true if everything asked for happened.
export function applyDecision(world, side, move, act = null) {
  if (world.over) return false;
  const me = world.fighters[side];
  if (me.stunTicks > 0) return false;
  me.stats.decisions += 1;
  const acting = act && act !== 'wait';
  me.lastActions.push([move, acting ? act : null].filter(Boolean).join('+'));
  if (me.lastActions.length > 3) me.lastActions.shift();
  let ok = true;
  if (move) ok = applyAction(world, side, move) && ok;
  if (acting) ok = applyAction(world, side, act) && ok;
  return ok;
}

function applyAction(world, side, action) {
  const me = world.fighters[side];
  const enemy = world.fighters[1 - side];

  if (isMovement(action)) {
    if (action === 'recharge' && me.chargeTicks > 0) return false;
    me.intent = action;
    return true;
  }

  const toEnemy = norm(sub(enemy, me));
  switch (action) {
    case 'shoot': {
      if (me.chargeTicks > 0 || me.cd.shoot > 0 || me.energy < C.BOLT.cost) return false;
      me.energy -= C.BOLT.cost;
      me.cd.shoot = T(C.BOLT.cooldown);
      me.stats.shots += 1;
      fire(world, me, enemy, 'bolt', C.BOLT.dmg * od(me), C.BOLT.speed, C.BOLT.radius);
      return true;
    }
    case 'charge': {
      if (me.chargeTicks > 0 || me.cd.charge > 0 || me.energy < C.BLAST.cost) return false;
      me.energy -= C.BLAST.cost;
      me.chargeTicks = T(C.BLAST.chargeTime);
      emit(world, 'charge_start', side, { x: me.x, y: me.y });
      return true;
    }
    case 'shield': {
      if (me.shieldTicks > 0 || me.cd.shield > 0 || me.energy < C.SHIELD.cost) return false;
      me.energy -= C.SHIELD.cost;
      me.shieldTicks = T(C.SHIELD.duration);
      me.cd.shield = T(C.SHIELD.cooldown);
      if (me.chargeTicks > 0) cancelCharge(world, me);
      emit(world, 'shield', side, { x: me.x, y: me.y });
      return true;
    }
    case 'dash': {
      if (me.cd.dash > 0 || me.energy < C.DASH.cost) return false;
      me.energy -= C.DASH.cost;
      me.cd.dash = T(C.DASH.cooldown);
      me.dashTicks = T(C.DASH.duration);
      me.dashDir = chooseDashDir(world, me, enemy, toEnemy);
      if (me.chargeTicks > 0) cancelCharge(world, me);
      emit(world, 'dash', side, { x: me.x, y: me.y });
      return true;
    }
    case 'melee': {
      if (me.chargeTicks > 0 || me.cd.melee > 0) return false;
      const d = dist(me, enemy);
      if (d > C.MELEE.lungeRange) return false;
      me.cd.melee = T(C.MELEE.cooldown);
      me.stats.melees += 1;
      // Lunge up to 1m so the strike connects from just outside range.
      const lunge = Math.max(0, Math.min(1.0, d - (C.MELEE.range - 0.2)));
      const pos = resolveCollisions(add(me, mul(toEnemy, lunge)));
      me.x = pos.x;
      me.y = pos.y;
      if (dist(me, enemy) > C.MELEE.range || enemy.dashTicks > 0) {
        emit(world, 'whiff', side, { x: me.x, y: me.y });
        if (enemy.dashTicks > 0) enemy.stats.dodges += 1;
        return true;
      }
      me.stats.meleeHits += 1;
      const guardBreak = enemy.shieldTicks > 0;
      if (guardBreak) {
        enemy.shieldTicks = 0;
        emit(world, 'guard_break', side, { x: enemy.x, y: enemy.y });
      }
      if (enemy.chargeTicks > 0) cancelCharge(world, enemy);
      enemy.stunTicks = T(guardBreak ? C.MELEE.guardBreakStun : C.MELEE.stun);
      enemy.knockTicks = 4;
      enemy.knockVel = mul(toEnemy, C.MELEE.knockback / (4 * C.DT));
      damage(world, me, enemy, C.MELEE.dmg * od(me), 'melee');
      return true;
    }
    default:
      return false;
  }
}

function cancelCharge(world, f) {
  f.chargeTicks = 0;
  emit(world, 'charge_cancel', f.side, { x: f.x, y: f.y });
}

function chooseDashDir(world, me, enemy, toEnemy) {
  const left = perp(toEnemy);
  const right = mul(left, -1);
  // Prefer the side that moves away from the nearest incoming shot, else the side with more room.
  let threat = null;
  let bestEta = Infinity;
  for (const p of world.projectiles) {
    if (p.owner === me.side) continue;
    const rel = sub(me, p);
    const vv = dot(p.vel, p.vel);
    const t = dot(rel, p.vel) / vv;
    if (t > 0 && t < bestEta) {
      bestEta = t;
      threat = p;
    }
  }
  if (threat) {
    const side = dot(sub(me, threat), perp(threat.vel));
    const away = side >= 0 ? norm(perp(threat.vel)) : mul(norm(perp(threat.vel)), -1);
    return away;
  }
  const room = (d) => {
    const p = add(me, mul(d, C.DASH.distance));
    return -(Math.max(0, FR - p.x) + Math.max(0, p.x - (C.ARENA_W - FR)) + Math.max(0, FR - p.y) + Math.max(0, p.y - (C.ARENA_H - FR)));
  };
  const rl = room(left);
  const rr = room(right);
  if (rl === rr) return world.rng.next() < 0.5 ? left : right;
  return rl > rr ? left : right;
}

function fire(world, me, enemy, kind, dmg, speed, radius) {
  const dir = norm(sub(enemy, me));
  const start = add(me, mul(dir, FR + radius + 0.05));
  world.projectiles.push({
    id: world.nextId++,
    kind,
    owner: me.side,
    x: start.x,
    y: start.y,
    vel: mul(dir, speed),
    dmg,
    r: radius,
    dodged: false,
  });
  emit(world, kind === 'bolt' ? 'shot' : 'blast', me.side, { x: me.x, y: me.y });
}

// ---------- movement ----------

function desiredDirection(world, me, enemy) {
  const toEnemy = norm(sub(enemy, me));
  let dir = v(0, 0);
  let target = null;
  switch (me.intent) {
    case 'advance':
      dir = dist(me, enemy) > FR * 2 + 0.3 ? toEnemy : v(0, 0);
      target = enemy;
      break;
    case 'retreat':
      dir = mul(toEnemy, -1);
      break;
    case 'strafe_left':
      dir = perp(toEnemy);
      break;
    case 'strafe_right':
      dir = mul(perp(toEnemy), -1);
      break;
    case 'take_cover': {
      target = coverPoint(world, me.side);
      dir = dist(me, target) > 0.25 ? norm(sub(target, me)) : v(0, 0);
      break;
    }
    case 'grab_powerup': {
      target = nearestPowerup(world, me);
      dir = target ? norm(sub(target, me)) : v(0, 0);
      break;
    }
    case 'go_center': {
      target = v(C.ARENA_W / 2, C.ARENA_H / 2 + (me.side === 0 ? -1.9 : 1.9));
      dir = dist(me, target) > 0.4 ? norm(sub(target, me)) : v(0, 0);
      break;
    }
    default:
      dir = v(0, 0);
  }
  if (dir.x === 0 && dir.y === 0) return dir;
  if (me.intent === 'retreat' || me.intent === 'strafe_left' || me.intent === 'strafe_right') dir = avoidWalls(me, dir);
  return steerAroundPillars(me, dir, target);
}

function avoidWalls(p, dir) {
  const margin = 1.4;
  let push = v(0, 0);
  if (p.x < margin) push.x += (margin - p.x) / margin;
  if (p.x > C.ARENA_W - margin) push.x -= (p.x - (C.ARENA_W - margin)) / margin;
  if (p.y < margin) push.y += (margin - p.y) / margin;
  if (p.y > C.ARENA_H - margin) push.y -= (p.y - (C.ARENA_H - margin)) / margin;
  return norm(add(dir, mul(push, 1.6)));
}

function steerAroundPillars(me, dir, target) {
  const lookahead = 1.6;
  const targetDist = target ? dist(me, target) : Infinity;
  for (const p of C.PILLARS) {
    const rel = sub(p, me);
    const t = dot(rel, dir);
    if (t <= 0 || t > lookahead || t > targetDist + p.r) continue;
    const cross = rel.x * dir.y - rel.y * dir.x;
    if (Math.abs(cross) < p.r + FR + 0.05) {
      const tangent = cross > 0 ? perp(dir) : mul(perp(dir), -1);
      return norm(add(mul(dir, 0.35), tangent));
    }
  }
  return dir;
}

function resolveCollisions(pos) {
  let p = { x: pos.x, y: pos.y };
  for (const c of C.PILLARS) {
    const d = dist(p, c);
    const min = c.r + FR;
    if (d < min) {
      const n = d > 1e-9 ? norm(sub(p, c)) : v(1, 0);
      p = add(c, mul(n, min));
    }
  }
  return clampToArena(p);
}

// ---------- the tick ----------

export function step(world) {
  if (world.over) return;
  const [a, b] = world.fighters;

  for (const f of world.fighters) {
    for (const k of Object.keys(f.cd)) if (f.cd[k] > 0) f.cd[k] -= 1;
    if (f.shieldTicks > 0) f.shieldTicks -= 1;
    if (f.stunTicks > 0) f.stunTicks -= 1;
    if (f.overdriveTicks > 0) f.overdriveTicks -= 1;
  }

  // Movement
  for (const f of world.fighters) {
    const enemy = world.fighters[1 - f.side];
    const before = v(f.x, f.y);
    let vel = v(0, 0);
    if (f.dashTicks > 0) {
      vel = mul(f.dashDir, C.DASH.distance / C.DASH.duration);
      f.dashTicks -= 1;
    } else if (f.stunTicks === 0) {
      let speed = C.SPEED * (C.INTENT_SPEED[f.intent] ?? 1);
      if (f.shieldTicks > 0) speed *= C.SHIELD.moveMult;
      if (f.chargeTicks > 0) speed *= C.BLAST.chargeMoveMult;
      vel = mul(desiredDirection(world, f, enemy), speed);
    }
    if (f.knockTicks > 0) {
      vel = add(vel, f.knockVel);
      f.knockTicks -= 1;
    }
    const pos = resolveCollisions(add(f, mul(vel, C.DT)));
    f.x = pos.x;
    f.y = pos.y;
    f.move = sub(pos, before);
    f.face = norm(sub(enemy, f));
  }

  // Fighters can't overlap.
  const gap = dist(a, b);
  if (gap < FR * 2) {
    const n = gap > 1e-9 ? norm(sub(b, a)) : v(1, 0);
    const push = (FR * 2 - gap) / 2;
    const pa = resolveCollisions(sub(a, mul(n, push)));
    const pb = resolveCollisions(add(b, mul(n, push)));
    a.x = pa.x;
    a.y = pa.y;
    b.x = pb.x;
    b.y = pb.y;
  }

  // Heavy shots charging up
  for (const f of world.fighters) {
    if (f.chargeTicks > 0) {
      f.chargeTicks -= 1;
      if (f.chargeTicks === 0) {
        f.cd.charge = T(C.BLAST.cooldown);
        f.stats.blasts += 1;
        fire(world, f, world.fighters[1 - f.side], 'blast', C.BLAST.dmg * od(f), C.BLAST.speed, C.BLAST.radius);
      }
    }
  }

  // Energy
  for (const f of world.fighters) {
    const resting = f.intent === 'recharge' && f.chargeTicks === 0 && f.dashTicks === 0;
    f.energy = Math.min(C.MAX_ENERGY, f.energy + C.ENERGY_REGEN * C.DT * (resting ? C.RECHARGE_MULT : 1));
  }

  stepProjectiles(world);
  stepPowerups(world);
  stepZone(world);

  world.tick += 1;
  checkEnd(world);
}

function stepProjectiles(world) {
  const SUB = 2;
  const keep = [];
  for (const p of world.projectiles) {
    let alive = true;
    for (let s = 0; s < SUB && alive; s++) {
      p.x += (p.vel.x * C.DT) / SUB;
      p.y += (p.vel.y * C.DT) / SUB;
      if (p.x < 0 || p.x > C.ARENA_W || p.y < 0 || p.y > C.ARENA_H) {
        alive = false;
        break;
      }
      for (const c of C.PILLARS) {
        if (dist(p, c) < c.r + p.r) {
          emit(world, 'impact', p.owner, { x: p.x, y: p.y, kind: p.kind });
          alive = false;
          break;
        }
      }
      if (!alive) break;
      const target = world.fighters[1 - p.owner];
      const shooter = world.fighters[p.owner];
      if (dist(p, target) < FR + p.r) {
        if (target.dashTicks > 0) {
          if (!p.dodged) {
            p.dodged = true;
            target.stats.dodges += 1;
            emit(world, 'dodge', target.side, { x: target.x, y: target.y });
          }
          continue;
        }
        let amount = p.dmg;
        if (target.shieldTicks > 0) {
          const blocked = amount * C.SHIELD.reduction;
          amount -= blocked;
          target.stats.blocked += blocked;
          emit(world, 'blocked', target.side, { x: target.x, y: target.y, amount: blocked });
        }
        if (p.kind === 'bolt') shooter.stats.hits += 1;
        else shooter.stats.blastHits += 1;
        damage(world, shooter, target, amount, p.kind);
        alive = false;
      }
    }
    if (alive) keep.push(p);
  }
  world.projectiles = keep;
}

function stepPowerups(world) {
  for (const pu of world.powerups) pu.ttl -= 1;
  world.powerups = world.powerups.filter((pu) => pu.ttl > 0);

  if (world.tick >= world.nextPowerupTick) {
    world.nextPowerupTick += T(C.POWERUP.every);
    if (world.powerups.length < C.POWERUP.max) {
      const free = C.POWERUP_PADS.filter((pad) => !world.powerups.some((pu) => pu.x === pad.x && pu.y === pad.y));
      const pad = world.rng.pick(free);
      const type = world.rng.pick(C.POWERUP_TYPES);
      world.powerups.push({ id: world.nextId++, x: pad.x, y: pad.y, type, ttl: T(C.POWERUP.ttl) });
      emit(world, 'powerup_spawn', -1, { x: pad.x, y: pad.y, kind: type });
    }
  }

  for (const pu of [...world.powerups]) {
    const takers = world.fighters
      .filter((f) => dist(f, pu) <= C.POWERUP.pickupRadius)
      .sort((f1, f2) => dist(f1, pu) - dist(f2, pu));
    if (takers.length === 0) continue;
    const f = takers[0];
    if (pu.type === 'repair') f.hp = Math.min(C.MAX_HP, f.hp + C.POWERUP.repair);
    if (pu.type === 'battery') f.energy = Math.min(C.MAX_ENERGY, f.energy + C.POWERUP.battery);
    if (pu.type === 'overdrive') f.overdriveTicks = T(C.POWERUP.overdriveTime);
    f.stats.pickups += 1;
    world.powerups = world.powerups.filter((x) => x !== pu);
    emit(world, 'pickup', f.side, { x: pu.x, y: pu.y, kind: pu.type });
  }
}

function stepZone(world) {
  const z = zoneAt(world.tick);
  if (!z.closing) return;
  if (world.tick === C.secondsToTicks(C.ZONE.startAt)) emit(world, 'zone_start', -1, {});
  for (const f of world.fighters) {
    if (insideZone(f, z)) continue;
    const dealt = Math.min(f.hp, C.ZONE.dps * C.DT);
    f.hp -= dealt;
    f.stats.damageTaken += dealt;
    f.stats.zoneDamage = (f.stats.zoneDamage || 0) + dealt;
    if (world.tick % 10 === 0) emit(world, 'zone_burn', f.side, { x: f.x, y: f.y });
  }
}

function checkEnd(world) {
  const [a, b] = world.fighters;
  const koA = a.hp <= 0;
  const koB = b.hp <= 0;
  if (koA || koB) {
    const winner = koA && koB ? null : koA ? 1 : 0;
    finish(world, winner, 'ko');
    return;
  }
  if (world.tick >= C.MATCH_TICKS) {
    const ha = Math.round(a.hp * 100);
    const hb = Math.round(b.hp * 100);
    let winner = null;
    if (ha !== hb) winner = ha > hb ? 0 : 1;
    else if (Math.round(a.stats.damageDealt * 100) !== Math.round(b.stats.damageDealt * 100))
      winner = a.stats.damageDealt > b.stats.damageDealt ? 0 : 1;
    finish(world, winner, 'timeout');
  }
}

function finish(world, winner, reason) {
  world.over = true;
  world.result = {
    winner,
    reason,
    tick: world.tick,
    hp: world.fighters.map((f) => Math.max(0, Math.round(f.hp * 10) / 10)),
    damage: world.fighters.map((f) => Math.round(f.stats.damageDealt * 10) / 10),
  };
  emit(world, winner === null ? 'draw' : 'ko', winner ?? -1, { reason });
}

// Compact snapshot for renderers and replay checkpoints.
export function snapshot(world) {
  return {
    tick: world.tick,
    fighters: world.fighters.map((f) => ({
      x: f.x,
      y: f.y,
      hp: f.hp,
      energy: f.energy,
      face: f.face,
      intent: f.intent,
      shield: f.shieldTicks,
      charge: f.chargeTicks,
      dash: f.dashTicks,
      stun: f.stunTicks,
      overdrive: f.overdriveTicks,
      cd: { ...f.cd },
    })),
    projectiles: world.projectiles.map((p) => ({ id: p.id, kind: p.kind, owner: p.owner, x: p.x, y: p.y, r: p.r })),
    powerups: world.powerups.map((p) => ({ id: p.id, type: p.type, x: p.x, y: p.y, ttl: p.ttl })),
  };
}

