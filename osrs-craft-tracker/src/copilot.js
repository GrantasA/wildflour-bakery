'use strict';

const { priceCurve, fillAt } = require('./market');
const { evaluateRecipe } = require('./optimizer');
const { taxPerItem } = require('./tax');
const { costOf, breakEvenPrice } = require('./positions');

// ---------- "Best in all aspects" ranking ----------

// Each metric is turned into a percentile rank among the crafts you could do
// right now, then blended. A craft only tops the list if it's good on most
// fronts, not just one.
const METRICS = [
  { key: 'profit', weight: 0.2, label: 'Big profit per batch', get: (r) => r.plan.profit },
  { key: 'active', weight: 0.2, label: 'Great profit for your time', get: (r) => r.plan.profitPerActiveHour },
  { key: 'hourly', weight: 0.15, label: 'Fast money per hour', get: (r) => r.plan.profitPerHour },
  { key: 'roi', weight: 0.15, label: 'High return on cash', get: (r) => r.plan.roi },
  { key: 'speed', weight: 0.1, label: 'Quick cycle', get: (r) => -r.plan.seconds },
  { key: 'safety', weight: 0.15, label: 'Reliable fills', get: (r) => -worstP90(r.plan) },
  { key: 'liquid', weight: 0.05, label: 'Liquid market', get: (r) => (r.flags.some((f) => f.startsWith('thin')) ? 0 : 1) },
];

function worstP90(plan) {
  return Math.max(...plan.inputs.map((i) => i.p90)) + plan.sell.p90;
}

function rankCrafts(results, maxActiveMinutes) {
  const pool = results.filter((r) => r.status === 'ok' && r.viable &&
    r.plan.activeSeconds <= maxActiveMinutes * 60);
  if (!pool.length) return [];
  const ranks = new Map(pool.map((r) => [r, {}]));
  for (const m of METRICS) {
    const vals = pool.map((r) => m.get(r)).sort((a, b) => a - b);
    for (const r of pool) {
      const v = m.get(r);
      // share of the pool this craft beats (ties count half)
      const below = vals.filter((x) => x < v).length;
      const equal = vals.filter((x) => x === v).length;
      ranks.get(r)[m.key] = pool.length === 1 ? 1 : (below + (equal - 1) / 2) / (pool.length - 1);
    }
  }
  for (const r of pool) {
    const rk = ranks.get(r);
    r.score = Math.round(100 * METRICS.reduce((a, m) => a + m.weight * rk[m.key], 0));
    r.reasons = METRICS.filter((m) => rk[m.key] >= 0.8 && m.key !== 'liquid').map((m) => m.label);
  }
  return pool.sort((a, b) => b.score - a.score);
}

// ---------- Advice for your open trades ----------

const MIN_BUDGET = 600; // never plan on less than 10 minutes left

function advise(pos, recipe, getItem, opts, now = Date.now()) {
  if (!recipe) return { kind: 'info', text: 'Recipe no longer exists in recipes.json.' };
  const fresh = evaluateRecipe({ ...recipe, batch: pos.batch }, getItem, opts);
  const output = getItem(pos.sell.name);
  const bought = pos.inputs.some((i) => i.bought);

  if (pos.status === 'buying') {
    const deadline = pos.createdAt + pos.plannedBuySeconds * 1000;
    const remaining = Math.max(MIN_BUDGET, (deadline - now) / 1000);
    let checkIn = 1800;
    const inputs = pos.inputs.map((inp) => {
      if (inp.bought) return { kind: 'done', text: `Bought at ${fmt(inp.boughtPrice)}` };
      const item = getItem(inp.name);
      if (!item) return { kind: 'info', text: 'No price data' };
      const cur = fillAt(item, 'buy', inp.qty, inp.offerPrice, opts);
      const pts = priceCurve(item, 'buy', inp.qty, opts).points;
      checkIn = Math.min(checkIn, Math.max(120, cur.median / 4));
      if (!pts.length) return { kind: 'keep', text: 'Not enough trade history to advise', median: cur.median };
      const fits = pts.filter((p) => p.median <= remaining);
      const target = fits.length ? fits[fits.length - 1] : pts[0];
      if (target.price > inp.offerPrice && cur.median > remaining * 1.25) {
        return { kind: 'raise', price: target.price, median: target.median,
          text: `Raise to ${fmt(target.price)}. At ${fmt(inp.offerPrice)} it's likely to take ~${dur(cur.median)}; you planned ~${dur(remaining)} more.` };
      }
      const saving = (inp.offerPrice - target.price) * inp.qty;
      if (target.price < inp.offerPrice * 0.99 && target.median <= remaining) {
        return { kind: 'lower', price: target.price, median: target.median,
          text: `Price dipped. Re-offer at ${fmt(target.price)} to save ~${fmt(saving)} and still fill in ~${dur(target.median)}.` };
      }
      return { kind: 'keep', median: cur.median, text: `Keep it. Likely fills in ~${dur(cur.median)}.` };
    });
    const cost = pos.inputs.reduce((a, inp, i) => {
      const adv = inputs[i];
      const price = inp.bought ? inp.boughtPrice : adv.kind === 'raise' ? adv.price : inp.offerPrice;
      return a + price * inp.qty;
    }, 0) + (pos.coins || 0);
    const sellPrice = fresh.status === 'ok' ? fresh.plan.sell.price : output?.latest?.low;
    const projected = sellPrice ? pos.sell.qty * (sellPrice - taxPerItem(sellPrice, pos.sell.name)) - cost : null;
    const res = { inputs, projectedProfit: projected, projectedSell: sellPrice, checkInSeconds: Math.round(checkIn) };
    if (projected != null && projected < 0) {
      return { ...res, kind: 'cancel',
        text: `Cancel your open buy offers: at today's prices this batch would lose ~${fmt(-projected)}.` +
          (bought ? ' You can hold what you already bought, or sell it back.' : '') };
    }
    const actions = inputs.filter((i) => i.kind === 'raise' || i.kind === 'lower').length;
    return { ...res, kind: actions ? 'adjust' : 'keep',
      text: actions ? `${actions} offer${actions > 1 ? 's' : ''} to adjust.` : `All offers look good. Check back in ~${dur(checkIn)}.` };
  }

  if (!output) return { kind: 'info', text: 'No price data for the product' };
  const cost = costOf(pos);
  const breakEven = breakEvenPrice(cost, pos.sell.qty, pos.sell.name);
  const pts = priceCurve(output, 'sell', pos.sell.qty, opts).points;
  const profitAt = (s) => pos.sell.qty * (s - taxPerItem(s, pos.sell.name)) - cost;

  if (pos.status === 'ready') {
    if (!pts.length) return { kind: 'info', text: 'Not enough trade history to suggest a price', breakEven };
    const craftSec = (recipe.craftSeconds || 3) * pos.batch;
    let best;
    if (opts.objective === 'profitPerHour') {
      best = pts.reduce((b, p) => (profitAt(p.price) / (p.median + craftSec) > profitAt(b.price) / (b.median + craftSec) ? p : b));
    } else {
      const fits = pts.filter((p) => p.median <= opts.maxWaitHours * 3600);
      best = fits.length ? fits[fits.length - 1] : pts[0];
    }
    const quick = pts[0];
    const p = profitAt(best.price);
    return {
      kind: 'list', price: best.price, median: best.median, breakEven,
      quick: { price: quick.price, median: quick.median, profit: profitAt(quick.price) },
      projectedProfit: p,
      text: p >= 0
        ? `Craft your ${pos.batch}, then list ${pos.sell.qty.toLocaleString()} at ${fmt(best.price)}. Likely sells in ~${dur(best.median)} for ~${fmt(p)} profit.`
        : `The market fell. At ${fmt(best.price)} you'd lose ~${fmt(-p)}. Break-even is ${fmt(breakEven)}, so holding may be better.`,
    };
  }

  if (pos.status === 'selling') {
    const offer = pos.sell.offerPrice;
    const cur = fillAt(output, 'sell', pos.sell.qty, offer, opts);
    const remaining = Math.max(MIN_BUDGET,
      (pos.sell.placedAt + Math.max(pos.plannedSellSeconds, 1800) * 1000 - now) / 1000);
    const base = { breakEven, median: cur.median, projectedProfit: profitAt(offer),
      checkInSeconds: Math.round(Math.max(120, Math.min(1800, cur.median / 4))) };
    if (!pts.length) return { ...base, kind: 'keep', text: 'Not enough trade history to advise' };
    const fits = pts.filter((p) => p.median <= remaining);
    const target = fits.length ? fits[fits.length - 1] : pts[0];
    if (target.price < offer && cur.median > remaining * 1.25) {
      const loss = profitAt(target.price) < 0;
      return { ...base, kind: 'lower', price: target.price,
        text: `Lower to ${fmt(target.price)}. At ${fmt(offer)} it's likely to take ~${dur(cur.median)}.` +
          (loss ? ` Careful: that's under break-even (${fmt(breakEven)}), a ~${fmt(-profitAt(target.price))} loss.` : '') };
    }
    if (target.price > offer * 1.01) {
      return { ...base, kind: 'raise', price: target.price,
        text: `The market rose. Relist at ${fmt(target.price)} for ~${fmt(profitAt(target.price) - profitAt(offer))} more.` };
    }
    return { ...base, kind: 'keep', text: `Keep it. Likely sells in ~${dur(cur.median)}.` };
  }
  return null;
}

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return s + (a / 1e3).toFixed(1) + 'K';
  return s + Math.round(a).toLocaleString('en-US');
}

function dur(sec) {
  if (!Number.isFinite(sec)) return 'forever';
  const m = Math.round(sec / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

module.exports = { rankCrafts, advise, METRICS };
