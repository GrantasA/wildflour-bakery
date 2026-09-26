'use strict';

const { taxPerItem } = require('./tax');

// Price AI: analog ("nearest neighbour") forecasting on price charts, for both
// buying and selling.
//
// For the item you want to trade, it describes the current chart as a feature
// vector (recent shape relative to now, volatility, position in its recent
// range, volume trend, spread, time of day). It then searches the history of
// every tracked item for the moments whose charts looked most similar and
// replays what actually happened in the following window.
//
// SELL: for each candidate price, P(a buyer pays at least that, with enough
//       volume, within the window) and what you'd get dumping at the end if not.
//       Pick the best expected payout after GE tax.
// BUY:  for each candidate price, P(a seller lets it go at or below that within
//       the window) and what you'd pay buying at the market at the end if not.
//       Pick the lowest expected cost.
//
// Risk: the "bad case" is the average of the worst 20% of outcomes. The risk
// setting blends it in (0 = pure average, 1 = weigh the bad case fully).
// Calibration: the journal's graded track record corrects the raw fill chance.
// Self-test: walk-forward backtests (train older 75%, test newest 25%) against
// the simple rule (sell 1gp under market / buy 1gp over the best bid), also
// used to tune how many similar charts to use.

const LAGS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 24];
const LOOKBACK = 24;
const K = 60;            // default number of similar charts, until tuning picks one
const K_CHOICES = [20, 40, 80, 160];
const GRID = 48;
const TAIL = 0.2;        // "bad case" = average of the worst 20% of outcomes
const MIN_SAMPLES = 400;
const FRESH = 2 * 3600;

function ffillLog(buckets, key) {
  const out = new Float64Array(buckets.length).fill(NaN);
  let last = NaN;
  for (let i = 0; i < buckets.length; i++) {
    const v = buckets[i][key];
    if (v != null && v > 0) last = Math.log(v);
    out[i] = last;
  }
  return out;
}

// Pre-processed view of one item's series.
function prepare(key, buckets, step) {
  const hi = ffillLog(buckets, 'avgHigh');
  const lo = ffillLog(buckets, 'avgLow');
  const mid = hi.map((h, i) => (Number.isNaN(lo[i]) ? h : Number.isNaN(h) ? lo[i] : (h + lo[i]) / 2));
  const vols = buckets.map((b) => b.highVol + b.lowVol);
  const typVol = Math.max(0.01, vols.reduce((a, v) => a + v, 0) / Math.max(1, buckets.length));
  return { key, buckets, step, hi, lo, mid, vols, typVol };
}

const BASE_DIM = LAGS.length + 6;
const CONTEXT_MARGIN = 0.0002;
const EXTRA_DIM = 5;

// Whole-market and related-item context for a dataset (see buildContext).
// Returns EXTRA_DIM numbers; zeros when nothing is known.
function contextFeatures(ctx, s, t) {
  const out = new Array(EXTRA_DIM).fill(0);
  if (!ctx) return out;
  const ts = s.buckets[t].ts, step = s.step;
  const move = (level, lag) => {
    const a = level.get(ts), b = level.get(ts - lag * step);
    return a != null && b != null ? a - b : 0;
  };
  // 1-2: the whole market's move over the last 6 and 24 buckets, in units of its usual swing
  out[0] = clamp(move(ctx.market, 6) / (ctx.marketVol * Math.sqrt(6)), -6, 6);
  out[1] = clamp(move(ctx.market, 24) / (ctx.marketVol * Math.sqrt(24)), -6, 6);
  // 3-4: items in the same recipes (ingredients <-> product)
  const rel = ctx.related.get(s.key);
  if (rel) {
    out[2] = clamp(move(rel.level, 6) / (rel.vol * Math.sqrt(6)), -6, 6);
    out[3] = clamp(move(rel.level, 24) / (rel.vol * Math.sqrt(24)), -6, 6);
  }
  // 5: is the craft margin (product vs ingredients) unusually wide or narrow right now?
  const m = ctx.margin.get(s.key);
  if (m) {
    const now = m.get(ts);
    const hist = [];
    for (let j = 1; j <= 48; j++) { const v = m.get(ts - j * step); if (v != null) hist.push(v); }
    if (now != null && hist.length >= 12) {
      const mu = hist.reduce((a, v) => a + v, 0) / hist.length;
      const sd = Math.sqrt(hist.reduce((a, v) => a + (v - mu) ** 2, 0) / hist.length) || 1e-3;
      out[4] = clamp((now - mu) / sd, -6, 6);
    }
  }
  return out;
}

// Build market / related-item / margin lookups for one bucket size.
//   series: prepared series; recipes: [{ inputs: [{item, qty}], output: {item, qty} }]
function buildContext(series, recipes) {
  const byName = new Map(series.map((s) => [s.key, s]));
  const midAt = (s) => {
    const m = new Map();
    s.buckets.forEach((b, i) => { if (!Number.isNaN(s.mid[i])) m.set(b.ts, s.mid[i]); });
    return m;
  };
  const mids = new Map(series.map((s) => [s.key, midAt(s)]));
  // an equal-weight index of the given items' log price changes
  const index = (names) => {
    const diffs = new Map();
    for (const n of names) {
      const s = byName.get(n);
      if (!s) continue;
      for (let i = 1; i < s.buckets.length; i++) {
        const d = s.mid[i] - s.mid[i - 1];
        if (!Number.isFinite(d)) continue;
        const e = diffs.get(s.buckets[i].ts) || [0, 0];
        e[0] += d; e[1]++;
        diffs.set(s.buckets[i].ts, e);
      }
    }
    const level = new Map();
    let acc = 0, sum2 = 0, n = 0;
    for (const ts of [...diffs.keys()].sort((a, b) => a - b)) {
      const [d, c] = diffs.get(ts);
      const avg = d / c;
      acc += avg; sum2 += avg * avg; n++;
      level.set(ts, acc);
    }
    return { level, vol: Math.sqrt(sum2 / Math.max(1, n)) || 1e-4 };
  };
  const market = index(series.map((s) => s.key));
  const relNames = new Map();
  const link = (a, b) => { if (a !== b) { if (!relNames.has(a)) relNames.set(a, new Set()); relNames.get(a).add(b); } };
  const margin = new Map();
  for (const r of recipes || []) {
    const names = [r.output.item, ...r.inputs.map((i) => i.item)];
    for (const a of names) for (const b of names) link(a, b);
    const members = names.map((n) => mids.get(n));
    if (members.some((m) => !m)) continue;
    const series_ = new Map();
    for (const [ts, out] of members[0]) {
      let cost = 0, ok = true;
      r.inputs.forEach((inp, i) => {
        const v = members[i + 1].get(ts);
        if (v == null) ok = false; else cost += inp.qty * Math.exp(v);
      });
      if (ok && cost > 0) series_.set(ts, out + Math.log(r.output.qty) - Math.log(cost));
    }
    for (const n of names) if (!margin.has(n)) margin.set(n, series_);
  }
  const related = new Map();
  for (const [n, set] of relNames) related.set(n, index([...set]));
  return { market: market.level, marketVol: market.vol, related, margin };
}

function features(s, t, ctx) {
  if (t < LOOKBACK || Number.isNaN(s.hi[t]) || Number.isNaN(s.hi[t - LOOKBACK]) || Number.isNaN(s.lo[t])) return null;
  let sum = 0, sum2 = 0, n = 0;
  for (let i = t - LOOKBACK + 1; i <= t; i++) {
    const d = s.mid[i] - s.mid[i - 1];
    if (Number.isNaN(d)) continue;
    sum += d; sum2 += d * d; n++;
  }
  if (n < 6) return null;
  const vol = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)) + 1e-4;
  const f = [];
  for (const j of LAGS) f.push(clamp((s.hi[t - j] - s.hi[t]) / vol, -8, 8));
  let mn = Infinity, mx = -Infinity;
  for (let i = t - LOOKBACK; i <= t; i++) { mn = Math.min(mn, s.hi[i]); mx = Math.max(mx, s.hi[i]); }
  f.push(mx > mn ? (s.hi[t] - mn) / (mx - mn) : 0.5);
  f.push(clamp((s.hi[t] - s.lo[t]) / vol, -8, 8));
  let v6 = 0, v24 = 0;
  for (let i = t - 5; i <= t; i++) v6 += s.vols[i];
  for (let i = t - 23; i <= t; i++) v24 += s.vols[i];
  f.push(Math.log((v6 / 6 + 1) / (v24 / 24 + 1)));
  const hour = ((s.buckets[t].ts / 3600) % 24) * (2 * Math.PI / 24);
  f.push(Math.sin(hour), Math.cos(hour));
  f.push(Math.log(vol));
  // context signals go last so the distance can include or ignore them
  f.push(...contextFeatures(ctx, s, t));
  return f;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// What happened after moment t, relative to the insta-buy price then.
function future(s, t, H) {
  const relHi = new Float64Array(H), hv = new Float64Array(H), relLo = new Float64Array(H), lv = new Float64Array(H);
  const hiT = new Array(H).fill(null), loT = new Array(H).fill(null); // exact trade prices, relative
  const ref = s.hi[t];
  let endLo = NaN, endHi = NaN;
  for (let k = 0; k < H; k++) {
    const b = s.buckets[t + 1 + k];
    relHi[k] = b.avgHigh ? Math.log(b.avgHigh) - ref : NaN;
    hv[k] = b.highVol;
    relLo[k] = b.avgLow ? Math.log(b.avgLow) - ref : NaN;
    lv[k] = b.lowVol;
    if (b.hiTicks) hiT[k] = b.hiTicks.map(([p, c]) => [Math.log(p) - ref, c]);
    if (b.loTicks) loT[k] = b.loTicks.map(([p, c]) => [Math.log(p) - ref, c]);
    if (b.avgLow) endLo = relLo[k];
    if (b.avgHigh) endHi = relHi[k];
  }
  if (Number.isNaN(endLo)) endLo = s.lo[t + H] - ref;
  if (Number.isNaN(endHi)) endHi = s.hi[t + H] - ref;
  let peak = -Infinity, trough = Infinity;
  for (let k = 0; k < H; k++) {
    for (const v of [relHi[k], relLo[k]]) if (!Number.isNaN(v)) { peak = Math.max(peak, v); trough = Math.min(trough, v); }
  }
  // exact trades can reach further than the averages
  for (const arr of [...hiT, ...loT]) {
    if (!arr) continue;
    for (const [v] of arr) { peak = Math.max(peak, v); trough = Math.min(trough, v); }
  }
  return { relHi, hv, relLo, lv, hiT, loT, endLo, endHi, peak, trough };
}

// Seconds until an offer at relative price x fills `need` units, or Infinity.
// A sell fills from trades at >= x, a buy from trades at <= x.
// A bucket's trades are spread around its average price, so only part of its
// volume traded at or better than x: about half when x equals the average,
// all of it once x is 1% better, none once it's 1% worse.
const SPREAD_LOG = 0.01;
function fillTime(fut, x, need, share, step, side = 'sell') {
  let cum = 0;
  const ok = side === 'sell' ? (v) => v >= x : (v) => v <= x;
  const frac = side === 'sell'
    ? (v) => (Number.isNaN(v) ? 0 : clamp(0.5 + (v - x) / (2 * SPREAD_LOG), 0, 1))
    : (v) => (Number.isNaN(v) ? 0 : clamp(0.5 + (x - v) / (2 * SPREAD_LOG), 0, 1));
  const ticks = (arr) => {
    if (!arr) return 0;
    let n = 0;
    for (const [v, c] of arr) if (ok(v)) n += c;
    return n;
  };
  for (let k = 0; k < fut.relHi.length; k++) {
    // the share of each bucket's volume at or better than x, or, if more,
    // the exact trades we captured at or better than x
    const part = (rel, vol, t) => Math.min(vol, Math.max(vol * frac(rel), ticks(t)));
    const v = share * (part(fut.relHi[k], fut.hv[k], fut.hiT[k]) + part(fut.relLo[k], fut.lv[k], fut.loT[k]));
    if (cum + v >= need) return (k + (v > 0 ? (need - cum) / v : 1)) * step;
    cum += v;
  }
  return Infinity;
}

// Average of the worst `alpha` share of outcomes when the offer fills with
// probability p (worth `fillVal`) and otherwise ends in one of `fallbacks`.
// For a sale "worst" means lowest; for a purchase it means most expensive.
function tailMean(p, fillVal, fallbacks, fw, alpha, side = 'sell') {
  const outcomes = [{ v: fillVal, m: p }, ...fallbacks.map((d) => ({ v: d.v, m: ((1 - p) * d.w) / fw }))]
    .sort((a, b) => (side === 'sell' ? a.v - b.v : b.v - a.v));
  let mass = 0, sum = 0;
  for (const o of outcomes) {
    const take = Math.min(o.m, alpha - mass);
    if (take <= 0) break;
    sum += take * o.v;
    mass += take;
  }
  return mass > 0 ? sum / mass : fillVal;
}

// Same as tailMean, for fallbacks already ordered worst-first.
function tailMeanSorted(p, fillVal, fallbacks, fw, alpha, side = 'sell') {
  const worse = side === 'sell' ? (a, b) => a < b : (a, b) => a > b;
  let mass = 0, sum = 0, placed = false;
  const takeSome = (v, m) => {
    const take = Math.min(m, alpha - mass);
    if (take > 0) { sum += take * v; mass += take; }
  };
  for (const d of fallbacks) {
    if (mass >= alpha) break;
    if (!placed && !worse(d.v, fillVal)) { takeSome(fillVal, p); placed = true; if (mass >= alpha) break; }
    takeSome(d.v, ((1 - p) * d.w) / fw);
  }
  if (!placed && mass < alpha) takeSome(fillVal, p);
  return mass > 0 ? sum / mass : fillVal;
}

const stepFor = (windowSec) => (windowSec <= 6 * 3600 ? 300 : 3600);
const horizonFor = (windowSec, step) => Math.max(1, Math.min(96, Math.round(windowSec / step)));

class PriceAI {
  constructor() {
    this.cache = new Map(); // `${step}:${H}` -> dataset
    this.recipes = [];
  }

  // Recipes tell the AI which items move together (ingredients <-> product).
  setRecipes(recipes) {
    const key = JSON.stringify(recipes.map((r) => [r.output.item, r.inputs.map((i) => i.item)]));
    if (key !== this.recipesKey) { this.recipes = recipes; this.recipesKey = key; this.cache.clear(); }
  }

  // items: [{ name, series5m, series1h }] for everything tracked.
  // Rebuilt when `version` changes (i.e. every price refresh).
  dataset(items, version, step, H) {
    if (typeof version === 'function') version = version(step);
    const key = `${step}:${H}`;
    const hit = this.cache.get(key);
    if (hit && hit.version === version) return hit;
    const series = [];
    const rows = [];
    for (const it of items) {
      // learn from the long saved history, not just the recent window
      const buckets = step === 300 ? (it.history5m || it.series5m) : (it.history1h || it.series1h);
      if (!buckets || buckets.length < LOOKBACK + H + 10) continue;
      series.push(prepare(it.name, buckets, step));
    }
    const ctx = buildContext(series, this.recipes);
    series.forEach((s, si) => {
      // Neighbouring moments are near-duplicates; cap each item at ~600 samples
      // so search stays fast as the saved history grows.
      const stride = Math.max(step === 300 ? 2 : 1, Math.ceil((s.buckets.length - LOOKBACK - H) / 600));
      for (let t = LOOKBACK; t + H < s.buckets.length; t += stride) {
        const f = features(s, t, ctx);
        if (f) rows.push({ si, t, f });
      }
    });
    // standardise each feature so no single one dominates the distance
    const dim = rows.length ? rows[0].f.length : 0;
    const mean = new Float64Array(dim), sd = new Float64Array(dim);
    for (const r of rows) for (let d = 0; d < dim; d++) mean[d] += r.f[d] / rows.length;
    for (const r of rows) for (let d = 0; d < dim; d++) sd[d] += (r.f[d] - mean[d]) ** 2 / rows.length;
    for (let d = 0; d < dim; d++) sd[d] = Math.sqrt(sd[d]) || 1;
    const X = new Float64Array(rows.length * dim);
    rows.forEach((r, i) => { for (let d = 0; d < dim; d++) X[i * dim + d] = (r.f[d] - mean[d]) / sd[d]; });
    const ds = { version, step, H, series, rows, X, dim, mean, sd, ctx,
      backtest: (hit && hit.backtest) || {}, bestK: (hit && hit.bestK) || {},
      // whether the market / related-item signals help, per side (decided by the backtest)
      useContext: (hit && hit.useContext) || {},
      memo: new Map(), nbrMemo: new Map() };
    this.cache.set(key, ds);
    return ds;
  }

  neighbours(ds, f, filter, k = K, useContext = false) {
    const q = f.map((v, d) => (v - ds.mean[d]) / ds.sd[d]);
    const dims = useContext ? ds.dim : Math.min(ds.dim, BASE_DIM);
    const best = []; // [dist, idx], kept sorted, size <= k
    for (let i = 0; i < ds.rows.length; i++) {
      if (filter && !filter(ds.rows[i])) continue;
      let dist = 0;
      for (let d = 0; d < dims; d++) {
        const z = ds.X[i * ds.dim + d] - q[d];
        dist += z * z;
        if (best.length === k && dist >= best[k - 1][0]) break;
      }
      if (best.length < k || dist < best[best.length - 1][0]) {
        // insert in sorted position (binary search) rather than re-sorting
        let a = 0, b = best.length;
        while (a < b) { const m = (a + b) >> 1; if (best[m][0] < dist) a = m + 1; else b = m; }
        best.splice(a, 0, [dist, i]);
        if (best.length > k) best.pop();
      }
    }
    return best.map(([dist, i]) => ({ dist, row: ds.rows[i] }));
  }

  // Core decision. Returns the best offer and, for comparison, the simple rule.
  //   side: 'sell' or 'buy'
  //   refLog: log of the last price a buyer paid (the anchor all futures are relative to;
  //           a recent trade, not a price that is guaranteed to fill now)
  //   lowLog: log of the last price a seller accepted
  //   calibrate(p): corrects the raw fill chance from the AI's graded record
  //   riskAversion: 0..1, how much the bad case counts
  decide(ds, nbrs, refLog, lowLog, qtyRel, share, itemName, { side = 'sell', calibrate, riskAversion = 0 } = {}) {
    ds.futMemo = ds.futMemo || new Map();
    const futs = nbrs.map(({ dist, row }) => {
      const s = ds.series[row.si];
      const key = row.si * 100000 + row.t;
      let fut = ds.futMemo.get(key);
      if (!fut) { fut = future(s, row.t, ds.H); ds.futMemo.set(key, fut); }
      return { fut, need: qtyRel * s.typVol, typVol: s.typVol, w: 1 / (1 + Math.sqrt(dist)) };
    });
    const wsum = futs.reduce((a, n) => a + n.w, 0);
    const sell = side === 'sell';
    const ext = futs.map((n) => (sell ? n.fut.peak : n.fut.trough)).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (p) => (ext.length ? ext[Math.min(ext.length - 1, Math.floor(p * ext.length))] : 0);
    const lowRel = lowLog - refLog;
    // search range: sell from just under the bid up to where 90% of similar charts peaked;
    // buy from where 10% of similar charts bottomed out up to just over the ask
    const lo = sell ? Math.min(lowRel, 0) - 0.005 : Math.min(q(0.1), lowRel) - 0.002;
    const hi = sell ? Math.max(q(0.9), 0.001) : 0.002;
    const price = (x) => Math.max(1, Math.round(Math.exp(refLog + x)));
    // value per unit: sell = net coins received, buy = coins paid
    const value = (x) => { const p = price(x); return sell ? p - taxPerItem(p, itemName) : p; };
    const fallAll = futs.map((n) => ({ v: value(sell ? n.fut.endLo : n.fut.endHi), w: n.w }));
    const xs = Array.from({ length: GRID + 1 }, (_, g) => lo + ((hi - lo) * g) / GRID);
    // Filling only gets easier as the offer gets more generous (lower sell,
    // higher buy), so for each similar chart binary-search the cut-off on the
    // price grid instead of testing every price.
    const fills = (n, x) => Number.isFinite(fillTime(n.fut, x, n.need, share, ds.step, side));
    const cut = futs.map((n) => {
      // sell: highest index that fills (-1 = none); buy: lowest index that fills (GRID+1 = none)
      let a = 0, b = GRID;
      if (sell) {
        if (!fills(n, xs[0])) return -1;
        while (a < b) { const m = (a + b + 1) >> 1; if (fills(n, xs[m])) a = m; else b = m - 1; }
        return a;
      }
      if (!fills(n, xs[GRID])) return GRID + 1;
      while (a < b) { const m = (a + b) >> 1; if (fills(n, xs[m])) b = m; else a = m + 1; }
      return a;
    });
    // fallbacks ordered worst-first once, so each grid point's tail is a linear walk
    const worstFirst = futs.map((_, i) => i).sort((a, b) => (sell ? fallAll[a].v - fallAll[b].v : fallAll[b].v - fallAll[a].v));
    const summarise = (x, filled) => {
      let pRaw = 0;
      for (let i = 0; i < futs.length; i++) if (filled(i)) pRaw += futs[i].w;
      const falls = [];
      for (const i of worstFirst) if (!filled(i)) falls.push(fallAll[i]);
      pRaw /= wsum;
      const pFill = calibrate ? calibrate(pRaw) : pRaw;
      const pool = falls.length ? falls : fallAll;
      const fw = pool.reduce((a, d) => a + d.w, 0);
      const fallMean = pool.reduce((a, d) => a + d.w * d.v, 0) / fw;
      const v = value(x);
      const ev = pFill * v + (1 - pFill) * fallMean;
      const bad = tailMeanSorted(pFill, v, pool, fw, TAIL, side);
      // score: higher is better for both sides
      const score = sell ? ev - riskAversion * (ev - bad) : -(ev + riskAversion * (bad - ev));
      return { x, price: price(x), ev, bad, score, pFill, pRaw };
    };
    // Honest completion times. If the offer hasn't filled by the end of the
    // window you still have to trade at the market, and that isn't instant
    // either: it takes about as long as the market needs to move your
    // quantity (your share of the usual volume on that side).
    const windowSec = ds.H * ds.step;
    const withTimes = (r) => {
      const filled = [];
      const all = futs.map((n) => {
        const t = fillTime(n.fut, r.x, n.need, share, ds.step, side);
        if (Number.isFinite(t)) { filled.push(t); return t; }
        return windowSec + (n.need / Math.max(1e-6, share * n.typVol / 2)) * ds.step;
      }).sort((a, b) => a - b);
      filled.sort((a, b) => a - b);
      const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : Infinity);
      return { ...r,
        median: q(all, 0.5), p90: q(all, 0.9),       // including the go-to-market fallback
        fillMedian: q(filled, 0.5) };                  // when the offer itself fills
    };
    let best = null;
    const curve = [];
    for (let g = 0; g <= GRID; g++) {
      const r = summarise(xs[g], (i) => (sell ? g <= cut[i] : g >= cut[i]));
      curve.push(r);
      if (!best || r.score > best.score) best = r;
    }
    best = withTimes(best);
    const evalAt = (x) => withTimes(summarise(x, (i) => fills(futs[i], x)));
    // the simple rule: sell 1gp under the ask, buy 1gp over the bid
    const rulePrice = sell ? Math.max(1, Math.round(Math.exp(refLog)) - 1) : Math.round(Math.exp(lowLog)) + 1;
    const rule = evalAt(Math.log(rulePrice) - refLog);
    return {
      best, rule, curve,
      range: { q25: price(q(0.25)), q50: price(q(0.5)), q75: price(q(0.75)) },
    };
  }

  // Suggest an offer price for `qty` of `item` to fill within `windowSec`.
  suggest(items, version, item, qty, windowSec, share, { side = 'sell', calibrate, riskAversion = 0 } = {}) {
    const step = stepFor(windowSec);
    const H = horizonFor(windowSec, step);
    // same (long) series the dataset was built from, so indices line up
    const buckets = step === 300 ? (item.history5m || item.series5m) : (item.history1h || item.series1h);
    if (!buckets || buckets.length < LOOKBACK + 2) return null;
    const ds = this.dataset(items, version, step, H);
    if (ds.rows.length < MIN_SAMPLES) return null;
    const l0 = item.latest || {};
    const memoKey = `${side}:${item.name}:${qty}:${share}:${riskAversion}:${calibrate ? calibrate.samples : 0}:${l0.high}:${l0.low}`;
    if (ds.memo.has(memoKey)) return ds.memo.get(memoKey);
    const s = prepare(item.name, buckets, step);
    const t = buckets.length - 1;
    const f = features(s, t, ds.ctx);
    if (!f) return null;
    // Anchor on the live market when it's fresh, else the chart's last prices.
    const l = item.latest || {};
    const now = Date.now() / 1000;
    const refLog = l.high && now - (l.highTime || 0) < FRESH ? Math.log(l.high) : s.hi[t];
    const lowLog = l.low && now - (l.lowTime || 0) < FRESH ? Math.log(l.low) : s.lo[t];
    // The similar-chart search depends only on the chart, so share it across
    // quantities, risk settings and both sides.
    const k = ds.bestK[side] || K;
    const useCtx = !!ds.useContext[side];
    const nk = `${item.name}:${k}:${useCtx}`;
    let nbrs = ds.nbrMemo.get(nk);
    if (!nbrs) {
      nbrs = this.neighbours(ds, f, (r) => !(ds.series[r.si].key === item.name && r.t > t - H), k, useCtx);
      ds.nbrMemo.set(nk, nbrs);
    }
    if (nbrs.length < 10) return null;
    const d = this.decide(ds, nbrs, refLog, lowLog, qty / s.typVol, share, item.name, { side, calibrate, riskAversion });
    const out = {
      source: 'ai',
      side,
      price: d.best.price,
      pFill: d.best.pFill,
      pRaw: d.best.pRaw,
      median: d.best.median,        // expected time to be done, incl. going to market if it doesn't fill
      p90: d.best.p90,
      fillMedian: d.best.fillMedian, // typical time when the offer itself fills
      expected: d.best.ev,  // sell: expected net per unit; buy: expected cost per unit
      bad: d.best.bad,      // average of the worst 20% of outcomes
      riskAversion,
      rule: { price: d.rule.price, pFill: d.rule.pFill, pRaw: d.rule.pRaw, expected: d.rule.ev },
      curve: d.curve.map((c) => ({ price: c.price, ev: c.ev, pFill: c.pFill })),
      range: d.range,
      neighbours: nbrs.length,
      usesContext: useCtx,
      windowSec,
      spark: buckets.slice(-Math.min(buckets.length, step === 300 ? 144 : 72)).map((b) => [b.ts, b.avgHigh, b.avgLow]),
      backtest: ds.backtest[side] || null,
    };
    ds.memo.set(memoKey, out);
    return out;
  }

  // Walk-forward test: train on the older 75% of each series, test on the
  // newest 25%. Compares the AI's realised result per unit against the simple
  // rule, and tunes the number of similar charts on the way.
  runBacktest(items, version, windowSec, share, { side = 'sell', maxTests = 200, riskAversion = 0 } = {}) {
    const step = stepFor(windowSec);
    const H = horizonFor(windowSec, step);
    const ds = this.dataset(items, version, step, H);
    if (ds.rows.length < MIN_SAMPLES) return null;
    const sell = side === 'sell';
    const split = new Map(ds.series.map((s, i) => [i, Math.floor(s.buckets.length * 0.75)]));
    const tests = ds.rows.filter((r) => r.t >= split.get(r.si));
    const stride = Math.max(1, Math.floor(tests.length / maxTests));
    const maxK = K_CHOICES[K_CHOICES.length - 1];
    // Tune: every neighbour count, with and without the market/related signals.
    const variants = [];
    for (const ctx of [false, true]) for (const k of K_CHOICES) variants.push({ ctx, k, key: `${ctx ? 'ctx' : 'base'}:${k}` });
    const acc = new Map(variants.map((v) => [v.key, { ...v, n: 0, gain: 0, wins: 0, pred: 0, real: 0 }]));
    for (let i = 0; i < tests.length; i += stride) {
      const r = tests[i];
      const s = ds.series[r.si];
      const allBy = {
        false: this.neighbours(ds, r.f, (c) => c.t + H < split.get(c.si), maxK, false),
        true: this.neighbours(ds, r.f, (c) => c.t + H < split.get(c.si), maxK, true),
      };
      const refLog = s.hi[r.t], lowLog = s.lo[r.t];
      const qtyRel = 0.5; // half a typical bucket's volume
      const fut = future(s, r.t, H);
      const need = qtyRel * s.typVol;
      const base = Math.exp(refLog);
      // realised value per unit of an offer at relative price x
      const realised = (x) => {
        const filled = Number.isFinite(fillTime(fut, x, need, share, step, side));
        const p = Math.max(1, Math.round(Math.exp(refLog + (filled ? x : sell ? fut.endLo : fut.endHi))));
        return { v: sell ? p - taxPerItem(p, s.key) : p, filled };
      };
      const rulePrice = sell ? Math.max(1, Math.round(base) - 1) : Math.round(Math.exp(lowLog)) + 1;
      const ruleV = realised(Math.log(rulePrice) - refLog).v;
      for (const v of variants) {
        const nbrs = allBy[v.ctx].slice(0, v.k);
        if (nbrs.length < 10) continue;
        const d = this.decide(ds, nbrs, refLog, lowLog, qtyRel, share, s.key, { side, riskAversion });
        const a = realised(d.best.x);
        const gain = (sell ? a.v - ruleV : ruleV - a.v) / base; // positive = AI did better
        const m = acc.get(v.key);
        m.gain += gain; m.n++;
        if (gain >= 0) m.wins++;
        m.pred += d.best.pFill;
        m.real += a.filled ? 1 : 0;
      }
    }
    let best = null;
    const byVariant = {};
    for (const [key, m] of acc) {
      if (!m.n) continue;
      byVariant[key] = m.gain / m.n;
      // the extra signals must earn their place by a real margin (0.02% of price),
      // not by noise
      if (!best || byVariant[key] > byVariant[best.key] + (m.ctx && !best.ctx ? CONTEXT_MARGIN : 0)) best = m;
    }
    if (!best) return null;
    const m = best;
    const bestK = m.k;
    const baseBest = Math.max(...K_CHOICES.map((k) => byVariant[`base:${k}`] ?? -Infinity));
    const ctxBest = Math.max(...K_CHOICES.map((k) => byVariant[`ctx:${k}`] ?? -Infinity));
    const res = {
      side,
      tests: m.n,
      windowSec,
      k: bestK,
      usesContext: m.ctx,
      contextGain: Number.isFinite(ctxBest) && Number.isFinite(baseBest) ? ctxBest - baseBest : null,
      byVariant,
      uplift: m.gain / m.n, // fraction of price better than the simple rule
      winRate: m.wins / m.n,
      predictedFill: m.pred / m.n,
      actualFill: m.real / m.n,
      samples: ds.rows.length,
      at: Date.now(),
    };
    ds.backtest[side] = res;
    ds.bestK[side] = bestK;
    ds.useContext[side] = m.ctx;
    ds.memo.clear();
    ds.nbrMemo.clear();
    return res;
  }
}

module.exports = { PriceAI, features, prepare, future, fillTime, tailMean, tailMeanSorted, buildContext, contextFeatures, K_CHOICES, stepFor, BASE_DIM };
