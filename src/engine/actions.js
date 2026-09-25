import { BOLT, BLAST, SHIELD, DASH, MELEE, MAX_ENERGY } from './constants.js';
import { dist } from './vec.js';
import { hasLineOfSight, zoneAt, insideZone, coverPoint } from './world.js';

// Every decision picks two things at once, asked as two parallel questions:
//   a MOVE (where the legs go, lasts until the next decision)
//   an ACTION (what the hands do right now, or "wait")
// so a fighter can strafe and shoot, retreat and shield, advance and punch.
// Descriptions are sent to the brain as Choice criteria, so they are written for a model to read.

export const MOVES = {
  advance: 'Move toward the enemy.',
  retreat: 'Move away from the enemy.',
  strafe_left: 'Circle around the enemy to one side. A sideways-moving target is hard to hit from medium or long range.',
  strafe_right: 'Circle around the enemy to the other side. A sideways-moving target is hard to hit from medium or long range.',
  take_cover: 'Move behind the nearest pillar so the enemy loses line of sight.',
  grab_powerup: 'Move to the nearest power-up (repair, battery or overdrive).',
  go_center: 'Head for the middle of the arena, the last place the closing zone reaches.',
  recharge: 'Stand still and regenerate energy three times faster. An easy target while doing it.',
};

export const ACTS = {
  shoot: `Fire a quick bolt at the enemy (${BOLT.cost} energy, ${BOLT.dmg} damage). Cheap: fire freely whenever the enemy is in sight.`,
  charge: `Start charging a heavy shot that fires by itself after ${BLAST.chargeTime}s (${BLAST.cost} energy, ${BLAST.dmg} damage). Moving is very slow while charging and the enemy can see it coming.`,
  shield: `Raise a shield for ${SHIELD.duration}s that blocks ${Math.round(SHIELD.reduction * 100)}% of shot damage (${SHIELD.cost} energy). A melee strike breaks it.`,
  dash: `Dash sideways ${DASH.distance}m. Nothing can hit you during the dash (${DASH.cost} energy).`,
  melee: `Lunge and strike at close range (${MELEE.dmg} damage). Knocks the enemy back, breaks shields and cancels a heavy shot being charged.`,
  wait: 'Hold fire this moment.',
};

export const ACTIONS = { ...MOVES, ...ACTS };
export const ACTION_IDS = Object.keys(ACTIONS);
export const MOVEMENT_ACTIONS = Object.keys(MOVES);
export const INSTANT_ACTIONS = Object.keys(ACTS).filter((a) => a !== 'wait');

export const isMovement = (a) => a in MOVES;

// What makes sense right now. Unavailable options are not offered to the brain at all,
// which keeps the choice honest and the prompt short.
export function availableActions(world, side) {
  const me = world.fighters[side];
  const enemy = world.fighters[1 - side];
  const charging = me.chargeTicks > 0;

  const moves = ['advance', 'retreat', 'strafe_left', 'strafe_right'];
  // Cover only counts if it is inside the safe zone.
  if (insideZone(coverPoint(world, side), zoneAt(world.tick + 40))) moves.push('take_cover');
  if (world.powerups.length > 0) moves.push('grab_powerup');
  if (zoneAt(world.tick + 100).closing) moves.push('go_center');
  if (me.energy < MAX_ENERGY - 1 && !charging) moves.push('recharge');

  const acts = [];
  // A bolt with no line of sight just hits a pillar, so it isn't offered.
  if (!charging && me.cd.shoot === 0 && me.energy >= BOLT.cost && hasLineOfSight(me, enemy)) acts.push('shoot');
  if (!charging && me.cd.charge === 0 && me.energy >= BLAST.cost) acts.push('charge');
  if (me.shieldTicks === 0 && me.cd.shield === 0 && me.energy >= SHIELD.cost) acts.push('shield');
  if (me.cd.dash === 0 && me.energy >= DASH.cost) acts.push('dash');
  if (!charging && me.cd.melee === 0 && dist(me, enemy) <= MELEE.lungeRange) acts.push('melee');
  acts.push('wait');

  return {
    moves: MOVEMENT_ACTIONS.filter((a) => moves.includes(a)),
    acts: Object.keys(ACTS).filter((a) => acts.includes(a)),
  };
}
