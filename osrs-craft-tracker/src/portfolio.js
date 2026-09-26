'use strict';

const { costOf } = require('./positions');

// GP / slot planner: what to run in your free GE slots with your free GP so the
// total gp/h is as high as possible.
//
// Crafts run side by side, so their gp/h add up. Each one needs a slot per
// ingredient while buying and ties up its buy cost. Two crafts that trade the
// same item are never combined (they'd compete for the same sellers and buy
// limit), and nothing clashing with your open trades is picked.
//
// GP management: every craft is also tried at smaller batch sizes. A smaller
// batch buys faster and frees GP for another craft, so sometimes two half-size
// crafts earn more per hour than one big one, and sometimes one big batch wins.
// A small search picks the combination with the best total gp/h.

const OPEN = new Set(['buying', 'ready', 'selling']);
// Never suggest a craft earning less than this: an empty slot beats clicking
// for pocket change. (No floor relative to the best craft: one outlier
// estimate would hide everything else.)
const MIN_GPH = 50_000;
const MIN_SHARE_OF_BEST = 0;
const TOP_CANDIDATES = 12;
const MAX_STEPS = 200_000;

const gph = (r) => r.plan.riskAdjusted / Math.max(r.plan.hours, 1 / 60);

function itemsOf(r) {
  return [r.name, ...(r.ingredients || []).map((i) => i.item)];
}

// What your open trades already use.
function inUse(positions) {
  let cash = 0, slots = 0;
  const items = new Set();
  const trades = [];
  for (const p of positions) {
    if (!OPEN.has(p.status)) continue;
    const s = p.status === 'buying' ? p.inputs.filter((i) => !i.bought).length : p.status === 'selling' ? 1 : 0;
    cash += costOf(p);
    slots += s;
    items.add(p.name);
    for (const i of p.inputs) items.add(i.name);
    trades.push({ id: p.id, name: p.name, slots: s, status: p.status });
  }
  return { cash, slots, items, trades };
}

function eligible(results, busyItems, maxActiveMinutes) {
  // only unique crafts are suggested; bulk processing (herbs, bolts, bars...)
  // means hours of clicking and isn't what this tool is for
  return results.filter((r) => r.status === 'ok' && r.type !== 'processing' && r.viable && r.plan.riskAdjusted > 0 &&
    r.plan.activeSeconds <= maxActiveMinutes * 60 &&
    !(r.warnings || []).some((w) => w.kind === 'spike' || w.kind === 'crash') &&
    !itemsOf(r).some((n) => busyItems.has(n)));
}

// The gp/h a craft must reach to be worth suggesting, given the best available.
// Only crafts you can afford count as "the best", otherwise an out-of-reach
// 2B craft would push everything you *can* do under the bar.
function worthwhileFloor(results, minGph = MIN_GPH, freeGp = Infinity) {
  const best = Math.max(0, ...results.filter((r) => r.status === 'ok' && r.type !== 'processing' && r.viable &&
    r.plan.cost / Math.max(1, r.batch) <= freeGp).map(gph));
  return Math.max(minGph, MIN_SHARE_OF_BEST * best);
}

// Why nothing (more) is suggested, in plain words.
function explainEmpty({ results, busyItems, maxActiveMinutes, freeCash, freeSlots, floor }) {
  if (freeSlots <= 0) return 'All your GE slots are busy with open trades.';
  const ok = results.filter((r) => r.status === 'ok' && r.type !== 'processing');
  if (!ok.length) return 'Still loading prices.';
  const profitable = ok.filter((r) => r.viable && r.plan.riskAdjusted > 0);
  if (!profitable.length) {
    const thin = ok.filter((r) => r.plan.profit > 0 && r.flags.some((f) => /only trades/.test(f))).length;
    return thin
      ? `No unique craft fits your timeframe right now: ${thin} profitable one(s) trade too slowly to fill in time. Try a longer timeframe (8h or custom, e.g. 1d).`
      : 'No unique craft is profitable within your timeframe and risk right now. Try a longer timeframe or higher risk.';
  }
  const cand = eligible(results, busyItems, maxActiveMinutes);
  if (!cand.length) return 'The profitable crafts clash with your open trades, look like price spikes, or need too much clicking.';
  const worthy = cand.filter((r) => gph(r) >= floor);
  if (!worthy.length) return `Only low earners are available (under ${fmtGp(floor)} gp/h), so slots are left empty rather than wasting your clicks.`;
  const cheapest = Math.min(...worthy.map((r) => r.plan.cost / Math.max(1, r.batch)));
  if (cheapest > freeCash) return `The worthwhile crafts need more GP: the cheapest needs about ${fmtGp(cheapest)} for a single craft, you have ${fmtGp(freeCash)} free.`;
  return `The ${fmtGp(freeCash)} GP left doesn't stretch to another worthwhile craft at a batch size that pays.`;
}

function fmtGp(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

// results: evaluated crafts. replan(recipeId, batch) re-evaluates a craft at
// another batch size (or returns null).
function planSlots({ results, positions = [], capital, slots = 8, maxActiveMinutes = 15, replan, minGph = MIN_GPH }) {
  const used = inUse(positions);
  const freeCash = Math.max(0, capital - used.cash);
  const freeSlots = Math.max(0, slots - used.slots);
  const floor = worthwhileFloor(results, minGph, freeCash);
  const pool = eligible(results, used.items, maxActiveMinutes)
    .filter((r) => gph(r) >= floor)
    .sort((a, b) => gph(b) - gph(a)).slice(0, TOP_CANDIDATES);

  // batch options per craft: full, half, quarter, and "whatever GP is free"
  const options = pool.map((r) => {
    const opts = [r];
    const want = new Set();
    for (const f of [0.5, 0.25]) want.add(Math.floor(r.batch * f));
    if (r.plan.cost > freeCash) want.add(Math.floor((r.batch * freeCash) / r.plan.cost));
    for (const b of want) {
      if (b < 1 || b >= r.batch || !replan) continue;
      const alt = replan(r.id, b);
      if (alt && alt.status === 'ok' && alt.plan.riskAdjusted > 0) opts.push(alt);
    }
    return opts.filter((o) => o.plan.cost <= freeCash).map((o) => ({
      r: o, gph: gph(o), cost: o.plan.cost, slots: o.plan.inputs.length, items: itemsOf(o),
    })).filter((o) => o.gph >= floor);
  });

  // depth-first search with a simple upper bound
  const bestPerSlot = Math.max(0, ...options.flat().map((o) => o.gph / o.slots));
  let best = { gph: 0, picks: [] };
  let steps = 0;
  const chosen = [];
  const taken = new Set();
  const dfs = (i, cash, left, total) => {
    if (++steps > MAX_STEPS) return;
    if (total > best.gph) best = { gph: total, picks: [...chosen] };
    if (i >= options.length || left <= 0 || total + left * bestPerSlot <= best.gph) return;
    for (const o of options[i]) {
      if (o.cost > cash || o.slots > left || o.items.some((n) => taken.has(n))) continue;
      chosen.push(o);
      for (const n of o.items) taken.add(n);
      dfs(i + 1, cash - o.cost, left - o.slots, total + o.gph);
      for (const n of o.items) taken.delete(n);
      chosen.pop();
    }
    dfs(i + 1, cash, left, total); // skip this craft
  };
  dfs(0, freeCash, freeSlots, 0);

  const picks = best.picks.map(({ r, gph: g }) => ({
    id: r.id, name: r.name, icon: r.icon, batch: r.batch, slots: r.plan.inputs.length,
    cost: r.plan.cost, profit: r.plan.profit, badProfit: r.plan.badProfit, riskAdjusted: r.plan.riskAdjusted,
    pLoss: r.plan.pLoss, hours: r.plan.hours, activeSeconds: r.plan.activeSeconds, gph: g,
    scaled: r.batch < (pool.find((p) => p.id === r.id) || r).batch,
  }));
  return {
    slots, capital,
    usedByTrades: { slots: used.slots, cash: used.cash, trades: used.trades },
    freeSlots, freeCash,
    picks,
    gph: picks.reduce((a, p) => a + p.gph, 0),
    slotsPlanned: picks.reduce((a, p) => a + p.slots, 0),
    cashPlanned: picks.reduce((a, p) => a + p.cost, 0),
    profit: picks.reduce((a, p) => a + p.profit, 0),
    badProfit: picks.reduce((a, p) => a + p.badProfit, 0),
    searchSteps: steps,
    minGph: floor,
    // why nothing, or nothing more, was suggested
    note: picks.length && picks.reduce((a, p) => a + p.slots, 0) >= freeSlots ? null
      : explainEmpty({ results, busyItems: new Set([...used.items, ...picks.flatMap((p) => itemsOf(results.find((r) => r.id === p.id) || { name: p.name }))]),
        maxActiveMinutes, freeCash: freeCash - picks.reduce((a, p) => a + p.cost, 0),
        freeSlots: freeSlots - picks.reduce((a, p) => a + p.slots, 0), floor }),
  };
}

// For each profitable unique craft that isn't suggested, the reason why.
// suggested: Set of recipe ids that are suggested.
function whyNot({ results, suggested, busyItems, maxActiveMinutes, freeGp, floor, limit = 10 }) {
  const out = [];
  const cands = results.filter((r) => r.status === 'ok' && r.type !== 'processing' && r.plan.profit > 0 && !suggested.has(r.id))
    .sort((a, b) => b.plan.profit / Math.max(a.plan.hours, 1 / 60) - a.plan.profit / Math.max(b.plan.hours, 1 / 60));
  for (const r of cands) {
    let reason;
    const thin = r.flags.find((f) => /only trades/.test(f));
    const warn = (r.warnings || []).find((w) => w.kind === 'spike' || w.kind === 'crash');
    const perCraft = r.plan.cost / Math.max(1, r.batch);
    if (thin) reason = thin.replace(/ in your timeframe$/, '') + ' in your timeframe';
    else if (r.flags.some((f) => /slower than/.test(f))) reason = `takes ~${hrs(r.plan.hours)}, longer than your timeframe allows`;
    else if (r.flags.some((f) => /more than the market trades/.test(f))) reason = 'batch bigger than the market trades in your timeframe';
    else if (warn) reason = `${warn.item}: ${warn.text}`;
    else if (!(r.plan.riskAdjusted > 0)) reason = `too risky for your risk setting (bad case ${fmtGp(r.plan.badProfit)}, ${Math.round(r.plan.pLoss * 100)}% chance of a loss)`;
    else if (!r.viable) reason = r.flags[0] || 'not viable right now';
    else if (r.plan.activeSeconds > maxActiveMinutes * 60) reason = 'needs more than 15 minutes of clicking';
    else if (itemsOf(r).some((n) => busyItems.has(n))) reason = 'shares an item with one of your open trades';
    else if (perCraft > freeGp) reason = `needs ~${fmtGp(perCraft)} GP per craft, you have ${fmtGp(freeGp)} free`;
    else if (gph(r) < floor) reason = `only ${fmtGp(gph(r))} gp/h after risk (under ${fmtGp(floor)})`;
    else reason = 'ranked below the ones shown';
    out.push({ id: r.id, name: r.name, icon: r.icon, profit: r.plan.profit, gph: gph(r), reason });
    if (out.length >= limit) break;
  }
  return out;
}

function hrs(h) {
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

module.exports = { planSlots, inUse, eligible, gph, itemsOf, worthwhileFloor, explainEmpty, whyNot, MIN_GPH };
