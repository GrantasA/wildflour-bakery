'use strict';

// How long a batch of crafts takes you at the keyboard.
//
//   travel to the station once (anvil, furnace, altar...) and back
// + one bank trip per inventory load
// + every step of every craft (a chain like "cut onyx -> furnace -> string ->
//   enchant" is four steps, not one)
//
// Step times are in game ticks (0.6s) including the click. They're estimates;
// the real time learned from your trades (see positions.timingFactor) covers
// GE waiting, not this, so tweak the numbers here or per recipe if yours differ.

const TICK = 0.6;
const STEP_SECONDS = {
  combine: 3 * TICK,   // use one item on another
  chisel: 2 * TICK,    // cut a gem / fang / visage
  anvil: 5 * TICK,     // smith one item at an anvil
  furnace: 5 * TICK,   // craft one piece of jewellery at a furnace
  string: 2 * TICK,    // string an amulet
  enchant: 3 * TICK,   // cast an enchant spell
  altar: 5 * TICK,     // bless / attach a sigil at an altar
  craft: 3 * TICK,     // other one-click crafting
};
const BANK_TRIP = 15;            // open bank, deposit, withdraw, close
const TRAVEL = {                 // there and back, once per batch
  none: 0,
  anvil: 60,
  furnace: 60,
  altar: 60,
  karuulm: 240,                  // leather shaping station in the Karuulm Slayer Dungeon
};

// Seconds of actions for one craft.
function stepSeconds(recipe) {
  if (Array.isArray(recipe.steps) && recipe.steps.length) {
    return recipe.steps.reduce((a, [kind, count = 1]) => a + (STEP_SECONDS[kind] ?? STEP_SECONDS.craft) * count, 0);
  }
  return recipe.craftSeconds ?? 3;
}

// Hands-on seconds to make `n` crafts (not counting GE offers).
function craftTime(recipe, n) {
  if (n <= 0) return 0;
  const perInventory = Math.max(1, recipe.perInventory || 14);
  const travel = TRAVEL[recipe.station || 'none'] ?? 0;
  return travel + Math.ceil(n / perInventory) * BANK_TRIP + n * stepSeconds(recipe);
}

// Most crafts that fit in `seconds` of hands-on time (0 if not even one).
function maxCraftsWithin(recipe, seconds) {
  if (craftTime(recipe, 1) > seconds) return 0;
  let lo = 1, hi = 1;
  while (craftTime(recipe, hi * 2) <= seconds && hi < 1e7) hi *= 2;
  hi *= 2;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (craftTime(recipe, mid) <= seconds) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Human-readable breakdown for the dashboard.
function breakdown(recipe, n) {
  const perInventory = Math.max(1, recipe.perInventory || 14);
  const station = recipe.station || 'none';
  return {
    travel: TRAVEL[station] ?? 0,
    station,
    bankTrips: Math.ceil(n / perInventory),
    bankSeconds: Math.ceil(n / perInventory) * BANK_TRIP,
    perCraft: stepSeconds(recipe),
    steps: recipe.steps || null,
    crafts: n,
  };
}

module.exports = { craftTime, maxCraftsWithin, breakdown, stepSeconds, STEP_SECONDS, BANK_TRIP, TRAVEL };
