// Every number that shapes a fight lives here, so balance changes are one-line diffs.
// Time values are in seconds, distances in meters (the arena is 24 x 14 m).

// Bump whenever a change alters how fights play out. Replays record it, and the viewer warns
// when a replay was made with a different engine.
export const ENGINE_VERSION = 2;

export const TICK_HZ = 20;
export const DT = 1 / TICK_HZ;
export const MATCH_SECONDS = 60;
export const MATCH_TICKS = MATCH_SECONDS * TICK_HZ;

export const ARENA_W = 24;
export const ARENA_H = 14;

export const FIGHTER_RADIUS = 0.5;
export const MAX_HP = 100;
export const MAX_ENERGY = 100;
export const SPEED = 4.0;
// Pressing forward is a little faster than backing off, so a fighter that hides behind a pillar
// can be caught instead of being chased in circles forever.
export const INTENT_SPEED = { advance: 1.12, retreat: 0.85, strafe_left: 0.92, strafe_right: 0.92, take_cover: 0.9, grab_powerup: 1.0, go_center: 1.0 };
export const ENERGY_REGEN = 10;
export const RECHARGE_MULT = 3;

export const BOLT = { cost: 8, dmg: 7, speed: 13, radius: 0.15, cooldown: 0.35 };
export const BLAST = { cost: 30, dmg: 24, speed: 16, radius: 0.45, chargeTime: 1.0, cooldown: 1.5, chargeMoveMult: 0.3 };
export const SHIELD = { cost: 12, duration: 0.9, cooldown: 2.0, reduction: 0.8, moveMult: 0.5 };
export const DASH = { cost: 18, distance: 3.5, duration: 0.2, cooldown: 2.5 };
export const MELEE = { dmg: 11, range: 1.9, lungeRange: 2.9, cooldown: 0.9, knockback: 2.0, stun: 0.2, guardBreakStun: 0.6 };
export const POWERUP = {
  firstAt: 8,
  every: 10,
  max: 2,
  ttl: 15,
  pickupRadius: 1.0,
  repair: 30,
  battery: 60,
  overdriveTime: 6,
  overdriveMult: 1.5,
};

// The closing zone: from ZONE.startAt the safe area shrinks toward the center until ZONE.endAt.
// Anyone outside it loses ZONE.dps health per second. It ends stalemates and camping.
export const ZONE = { startAt: 25, endAt: 50, minW: 6, minH: 4, dps: 6 };

// Pillars are point-symmetric around the arena center, so neither side has a map advantage.
// The center is open ground on purpose: the closing zone ends there, with nowhere to hide.
export const PILLARS = [
  { x: 12, y: 3.2, r: 0.7 },
  { x: 12, y: 10.8, r: 0.7 },
  { x: 8, y: 4.5, r: 1.0 },
  { x: 16, y: 9.5, r: 1.0 },
  { x: 8, y: 10.5, r: 0.8 },
  { x: 16, y: 3.5, r: 0.8 },
];

export const POWERUP_PADS = [
  { x: 12, y: 5.3 },
  { x: 12, y: 8.7 },
  { x: 5, y: 11.5 },
  { x: 19, y: 2.5 },
]

export const POWERUP_TYPES = ['repair', 'battery', 'overdrive'];

export const SPAWNS = [
  { x: 2.5, y: 7 },
  { x: 21.5, y: 7 },
];

// Decision pacing. Real-time mode never asks a brain more often than this.
export const MIN_DECISION_INTERVAL_S = 0.15;
// Lockstep mode asks both brains every N ticks and pauses the world while they think.
export const LOCKSTEP_EVERY_TICKS = 4;

// Published TypeSafe price for Jev input tokens (output tokens are free).
export const JEV_USD_PER_MILLION_INPUT = 0.042;

export const secondsToTicks = (s) => Math.round(s * TICK_HZ);
