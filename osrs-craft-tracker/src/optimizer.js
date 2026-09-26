'use strict';

const { priceCurve, fillAt, sellOptions, buyLimitSeconds, dailyVolume } = require('./market');
const { priceMoveRisk, warnings } = require('./risk');
const { craftTime, maxCraftsWithin, breakdown } = require('./effort');
const { taxPerItem } = require('./tax');

const DEFAULTS = {
  share: 0.33,         // fraction of matching market flow your offer captures (others queue ahead of you)
  maxWaitHours: 24,    // ignore plans slower than this
  sellWithinHours: 2,  // list at a price that sells within this, even in the slow case
  riskAversion: 0.4,   // 0 = chase the average, 1 = weigh the bad case fully
  capital: 100_000_000,
  objective: 'profitPerHour', // or 'profit', or 'activeProfit'
};

// Buy windows the price AI is asked about when building an input's options.
const AI_BUY_WINDOWS = [5 / 60, 0.5, 1, 4, 8, 12, 24, 48].map((h) => Math.round(h * 3600));

// How many batch sizes to try when choosing the best one.
const BATCH_STEPS = 4;
const batchHints = new Map(); // recipe + settings -> last best batch

// Hands-on time to place and collect one GE offer.
const OFFER_SECONDS = 15;

// How many crafts to plan per cycle: as many as every input's 4-hour buy limit
// allows, capped by the capital you're willing to tie up.
function batchSize(recipe, inputs, capital, maxActiveMinutes = Infinity) {
  if (recipe.batch) return recipe.batch;
  let n = Infinity;
  for (const inp of inputs) {
    if (inp.item.limit) n = Math.min(n, Math.floor(inp.item.limit / inp.qty));
  }
  if (!Number.isFinite(n)) n = 1;
  const unitCost = inputs.reduce((a, i) => a + i.qty * (i.item.latest.high || i.item.latest.low || 0), 0)
    + (recipe.coins || 0);
  if (unitCost > 0) n = Math.min(n, Math.floor(capital / unitCost));
  // "least work": no more crafts than fit in your clicking limit (bank trips,
  // walking to the station and every crafting step included)
  if (Number.isFinite(maxActiveMinutes)) {
    const budget = maxActiveMinutes * 60 - OFFER_SECONDS * (inputs.length + 1);
    n = Math.min(n, maxCraftsWithin(recipe, budget));
  }
  return Math.max(1, n);
}

// Hard reality check, independent of any model: how many crafts can the market
// actually supply in your timeframe? For each ingredient (and the product) take
// the units it trades per day, the share of them you can expect to get, and how
// much of a day your timeframe is. No plan may need more than that.
function volumeCheck(recipe, inputs, output, share, buyWindowSec, sellWindowSec) {
  const lines = [];
  let maxBatch = Infinity;
  const add = (item, perCraft, windowSec, side) => {
    const perDay = dailyVolume(item);
    if (perDay == null) return;
    const canGet = (share * perDay * windowSec) / 86400; // units you can expect in the window
    const crafts = Math.floor(canGet / perCraft);
    lines.push({ name: item.name, side, perDay, canGet, crafts });
    maxBatch = Math.min(maxBatch, crafts);
  };
  inputs.forEach((inp) => add(inp.item, inp.qty, buyWindowSec, 'buy'));
  add(output, recipe.output.qty, sellWindowSec, 'sell');
  return { maxBatch, lines };
}

// buys[i] / sell: offer options. Optional fields from the price AI:
//   buy.cost  expected cost per unit (includes buying at market if the offer doesn't fill)
//   sell.net  expected net per unit after tax (includes dumping if it doesn't sell)
//   sell.bad  bad-case net per unit (average of its worst 20% outcomes)
function evaluatePlan(recipe, inputs, output, n, buys, sell, opts = DEFAULTS) {
  const outQty = recipe.output.qty * n;
  const cost = buys.reduce((a, b, i) => a + (b.cost ?? b.price) * inputs[i].qty * n, 0) + (recipe.coins || 0) * n;
  const taxEach = taxPerItem(sell.price, output.name);
  const netEach = sell.net ?? sell.price - taxEach;
  const revenue = sell.price * outQty;
  const taxTotal = taxEach * outQty;
  const profit = netEach * outQty - cost;
  // timeFactor: learned from how long your real offers took vs what we predicted
  const tf = opts.timeFactor || 1;
  const buySeconds = Math.max(...buys.map((b) => b.median)) * tf;
  const sellSeconds = sell.median * tf;
  const craftSeconds = craftTime(recipe, n);
  const seconds = buySeconds + craftSeconds + sellSeconds;
  // Time you actually spend at the keyboard: placing/collecting offers and
  // crafting. GE waiting is passive, so it doesn't count here.
  const activeSeconds = craftSeconds + OFFER_SECONDS * (inputs.length + 1);

  // Risk: the product's price can move while you buy and craft.
  const move = priceMoveRisk(output, buySeconds + craftSeconds);
  const badEach = (sell.bad ?? netEach) * (move ? Math.exp(move.q10) : 1);
  const badProfit = badEach * outQty - cost;
  const breakEvenEach = cost / outQty;
  let pLoss;
  if (netEach <= 0 || breakEvenEach >= netEach) pLoss = profit < 0 ? 1 : 0.5;
  else pLoss = move ? move.probBelow(Math.log(breakEvenEach / netEach)) : (profit < 0 ? 1 : 0);
  const riskAdjusted = profit - opts.riskAversion * Math.max(0, profit - badProfit);

  return {
    inputs: inputs.map((inp, i) => ({
      name: inp.item.name, id: inp.item.id, icon: inp.item.icon, qty: inp.qty * n, price: buys[i].price,
      expectedCost: buys[i].cost ?? null, ai: !!buys[i].ai, pFill: buys[i].pFill ?? null,
      windowSec: buys[i].windowSec ?? null,
      perDay: dailyVolume(inp.item),
      median: buys[i].median * tf, p90: buys[i].p90 * tf,
      instaBuy: inp.item.latest.high, instaSell: inp.item.latest.low,
    })),
    sell: { name: output.name, id: output.id, icon: output.icon, qty: outQty, perDay: dailyVolume(output), price: sell.price, tax: taxEach,
      expectedNet: sell.net ?? null, ai: !!sell.ai, pFill: sell.pFill ?? null,
      median: sellSeconds, p90: sell.p90 * tf, instaBuy: output.latest.high, instaSell: output.latest.low },
    cost, revenue, taxTotal, profit,
    profitPerCraft: profit / n,
    buySeconds, seconds,
    hours: seconds / 3600,
    profitPerHour: profit / (seconds / 3600),
    craftSeconds, activeSeconds,
    effort: { ...breakdown(recipe, n), offers: inputs.length + 1, offerSeconds: OFFER_SECONDS * (inputs.length + 1) },
    profitPerActiveHour: profit / (activeSeconds / 3600),
    roi: cost > 0 ? profit / cost : 0,
    badProfit, pLoss, riskAdjusted,
    timeFactor: tf,
    riskSource: move ? move.source : null,
  };
}

function score(plan, objective) {
  // Active time is fixed for a given batch, so maximising profit per active
  // hour means taking the most (risk-adjusted) profit the max-wait allows.
  return objective === 'profitPerHour' ? plan.riskAdjusted / plan.hours : plan.riskAdjusted;
}

// Buy options for one input from the price AI: ask what it would offer for
// several time windows, and keep the ones where waiting longer is cheaper.
// (No separate "pay the ask now" option: the AI's shortest window already
// covers quick buys, priced with its own view of how likely they are to fill.)
function aiBuyCurve(advisor, item, qty, maxSec, opts) {
  // every standard window up to your timeframe, plus the timeframe itself
  const windows = [...new Set([...AI_BUY_WINDOWS.filter((w) => w < maxSec), Math.max(maxSec, AI_BUY_WINDOWS[0])])];
  const limitSec = buyLimitSeconds(qty, item.limit);
  const pts = [];
  for (const w of windows) {
    const a = advisor(item, qty, w);
    if (!a) continue;
    // a.median already includes buying at market (which also takes time) if the offer doesn't fill
    const t = Math.max(60, a.median, limitSec);
    pts.push({ price: a.price, cost: a.expected, median: t, p90: Math.max(a.p90, limitSec), pFill: a.pFill, ai: true, windowSec: w });
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a.median - b.median || a.cost - b.cost);
  const frontier = [];
  for (const p of pts) if (!frontier.length || p.cost < frontier[frontier.length - 1].cost) frontier.push(p);
  return { points: frontier, series: 'ai' };
}

// Pick the batch size with the best score (gp/h by default). Bigger batches
// make more per cycle but take longer to buy and sell, so the best size is
// often below the maximum the buy limits, your GP and your clicking limit
// allow. Tries a spread of sizes from 1 to that maximum, then refines around
// the best one.
function evaluateRecipe(recipe, getItem, settings = {}) {
  const opts = { ...DEFAULTS, ...settings };
  if (recipe.batch) return evaluateAtBatch(recipe, getItem, opts);
  const first = evaluateAtBatch(recipe, getItem, opts); // at the maximum batch
  if (first.status === 'ok') first.maxBatch = first.batch;
  if (first.status !== 'ok' || first.batch <= 1) return first;
  const nMax = first.batch;
  const tried = new Map([[nMax, first]]);
  const tryBatch = (b) => {
    b = Math.max(1, Math.min(nMax, Math.round(b)));
    if (!tried.has(b)) tried.set(b, evaluateAtBatch({ ...recipe, batch: b }, getItem, opts));
    return tried.get(b);
  };
  const val = (r) => (r.status === 'ok' ? score(r.plan, opts.objective) : -Infinity);
  // Last minute's winner is usually still close, so start from there when we
  // have one; otherwise spread sizes log-evenly between 1 and the maximum.
  const hintKey = `${recipe.id}:${opts.capital}:${opts.riskAversion}:${opts.buyWithinHours}:${opts.sellWithinHours}`;
  const hint = batchHints.get(hintKey);
  let rounds = 2;
  if (hint && hint <= nMax) {
    for (const b of [hint, hint * 1.5, hint / 1.5]) tryBatch(b);
    rounds = 1;
  } else {
    for (let k = 0; k < BATCH_STEPS; k++) tryBatch(Math.pow(nMax, k / (BATCH_STEPS - 1)));
  }
  // refine: halfway (geometrically) to the neighbours of the best size
  const sizes = () => [...tried.keys()].sort((a, b) => a - b);
  for (let round = 0; round < rounds; round++) {
    const list = sizes();
    const bestB = list.reduce((a, b) => (val(tried.get(b)) > val(tried.get(a)) ? b : a));
    const i = list.indexOf(bestB);
    if (i > 0) tryBatch(Math.sqrt(list[i - 1] * bestB));
    if (i < list.length - 1) tryBatch(Math.sqrt(list[i + 1] * bestB));
  }
  const list = sizes();
  const bestB = list.reduce((a, b) => (val(tried.get(b)) > val(tried.get(a)) ? b : a));
  const best = tried.get(bestB);
  batchHints.set(hintKey, bestB);
  best.maxBatch = nMax;
  best.batchOptions = list.filter((b) => tried.get(b).status === 'ok')
    .map((b) => ({ batch: b, gph: tried.get(b).plan.riskAdjusted / Math.max(tried.get(b).plan.hours, 1 / 60), profit: tried.get(b).plan.profit }));
  return best;
}

function evaluateAtBatch(recipe, getItem, opts) {
  const base = {
    id: recipe.id, category: recipe.category, skills: recipe.skills, notes: recipe.notes,
    type: recipe.type === 'processing' ? 'processing' : 'unique',
    name: recipe.output.item, outputQty: recipe.output.qty,
    icon: getItem(recipe.output.item)?.icon || null,
    ingredients: recipe.inputs.map((i) => ({ item: i.item, qty: i.qty })), coins: recipe.coins || 0,
  };

  const missing = [];
  const inputs = recipe.inputs.map((i) => {
    const item = getItem(i.item);
    if (!item) missing.push(i.item);
    return { item, qty: i.qty };
  });
  const output = getItem(recipe.output.item);
  if (!output) missing.push(recipe.output.item);
  if (missing.length) return { ...base, status: 'missing', missing };

  const noPrice = [...inputs.map((i) => i.item), output].filter((it) => !it.latest || (!it.latest.high && !it.latest.low));
  if (noPrice.length) return { ...base, status: 'nodata', missing: noPrice.map((i) => i.name) };

  const vol = volumeCheck(recipe, inputs, output, opts.share,
    (opts.buyWithinHours ?? opts.maxWaitHours) * 3600, (opts.sellWithinHours ?? opts.maxWaitHours) * 3600);
  let n = batchSize(recipe, inputs, opts.capital, opts.maxActive);
  // never plan more than the market can supply in your timeframe
  if (!recipe.batch && Number.isFinite(vol.maxBatch)) n = Math.max(1, Math.min(n, vol.maxBatch));
  // Let the price AI pick buy prices where it can; otherwise use the fill-time model.
  const buyCurves = inputs.map((inp) => (opts.buyAdvisor
    ? aiBuyCurve(opts.buyAdvisor, inp.item, inp.qty * n, (opts.buyWithinHours ?? opts.maxWaitHours) * 3600, opts) : null)
    || priceCurve(inp.item, 'buy', inp.qty * n, opts));
  const sellCurve = priceCurve(output, 'sell', recipe.output.qty * n, opts);
  // If the sell-price AI is available, let it pick the sell price; otherwise
  // list at or under the market within the sell window.
  const ai = opts.sellAdvisor ? opts.sellAdvisor(output, recipe.output.qty * n, opts.sellWithinHours * 3600) : null;
  let sellChoices;
  if (!ai) {
    sellChoices = sellOptions(output, recipe.output.qty * n, opts, undefined, undefined, sellCurve).points;
  } else {
    // ai.median includes dumping at market (which also takes time) if it doesn't sell
    sellChoices = [{ price: ai.price, net: ai.expected, bad: ai.bad, median: Math.max(60, ai.median), p90: ai.p90, pFill: ai.pFill, ai: true }];
  }
  const empty = [...buyCurves.map((c, i) => [c, inputs[i].item.name]), [sellCurve, output.name]]
    .filter(([c]) => c.points.length === 0).map(([, name]) => name);
  if (empty.length) return { ...base, status: 'nodata', batch: n, missing: empty };

  // Reference plan at the last traded prices (last price buyers paid for inputs,
  // last price sellers took for the output). Recent trades, not guaranteed fills,
  // so its times come from the same fill model as everything else.
  const instantBuys = inputs.map((inp) => ({
    price: inp.item.latest.high || inp.item.latest.low,
    ...fillAt(inp.item, 'buy', inp.qty * n, inp.item.latest.high || inp.item.latest.low, opts),
  }));
  const instaSellPrice = output.latest.low || output.latest.high;
  const instant = evaluatePlan(recipe, inputs, output, n,
    instantBuys, { price: instaSellPrice, ...fillAt(output, 'sell', recipe.output.qty * n, instaSellPrice, opts) }, opts);

  // Inputs are bought in parallel GE slots, so the buy phase lasts as long as the
  // slowest input. For every possible buy-phase time budget, take the cheapest
  // price per input that fills within it, then pair with every sell option.
  const budgets = [...new Set(buyCurves.flatMap((c) => c.points.map((p) => p.median)))].sort((a, b) => a - b);
  const maxSec = opts.maxWaitHours * 3600;
  let best = null, fastest = null;
  for (const budget of budgets) {
    const buys = [];
    for (const c of buyCurves) {
      let choice = null;
      for (const p of c.points) if (p.median <= budget) choice = p; // frontier: later = cheaper
      if (!choice) break;
      buys.push(choice);
    }
    if (buys.length !== buyCurves.length) continue;
    for (const s of sellChoices) {
      const plan = evaluatePlan(recipe, inputs, output, n, buys, s, opts);
      if (!fastest || plan.seconds < fastest.seconds) fastest = plan;
      if (plan.seconds > maxSec) continue;
      if (!best || score(plan, opts.objective) > score(best, opts.objective)) best = plan;
    }
  }
  const withinWait = !!best;
  if (!best) best = fastest;

  const flags = [];
  if (!withinWait) flags.push(`slower than ${opts.maxWaitHours}h max wait`);
  const series = [...buyCurves.map((c) => c.series), sellCurve.series];
  if (series.includes('1h')) flags.push('thin market (hourly data)');
  const tooThin = vol.lines.filter((l) => l.crafts < 1);
  for (const l of tooThin) {
    flags.push(`${l.name} only trades ~${Math.round(l.perDay).toLocaleString()}/day: not enough to ${l.side} even one craft's worth in your timeframe`);
  }
  if (!tooThin.length && Number.isFinite(vol.maxBatch) && n > vol.maxBatch) {
    flags.push(`batch of ${n} is more than the market trades in your timeframe (about ${vol.maxBatch})`);
  }
  const warn = [output, ...inputs.map((i) => i.item)].flatMap((it) =>
    warnings(it).map((w) => ({ ...w, item: it.name })));
  for (const w of warn) flags.push(`${w.item}: ${w.text}`);
  const staleCutoff = Date.now() / 1000 - 6 * 3600;
  const stale = [...inputs.map((i) => i.item), output].filter((it) =>
    Math.max(it.latest.highTime || 0, it.latest.lowTime || 0) < staleCutoff);
  if (stale.length) flags.push(`no trades in 6h: ${stale.map((s) => s.name).join(', ')}`);

  return {
    ...base,
    status: 'ok',
    batch: n,
    viable: withinWait && best.profit > 0 && best.riskAdjusted > 0 && !tooThin.length && !(n > vol.maxBatch),
    volume: vol.lines,
    warnings: warn,
    ai: ai ? { price: ai.price, pFill: ai.pFill, rule: ai.rule, neighbours: ai.neighbours } : null,
    aiBuys: buyCurves.some((c) => c.series === 'ai'),
    plan: best,
    instant,
    flags,
    curves: {
      inputs: buyCurves.map((c, i) => ({ name: inputs[i].item.name, series: c.series, points: c.points })),
      output: { name: output.name, series: sellCurve.series, points: sellCurve.points },
    },
  };
}

module.exports = { evaluateRecipe, batchSize, DEFAULTS, OFFER_SECONDS };
