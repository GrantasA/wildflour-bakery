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

function features(s, t) {
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
  return f;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// What happened after moment t, relative to the insta-buy price then.
function future(s, t, H) {
  const relHi = new Float64Array(H), hv = new Float64Array(H), relLo = new Float64Array(H), lv = new Float64Array(H);
  const ref = s.hi[t];
  let endLo = NaN, endHi = NaN;
  for (let k = 0; k < H; k++) {
    const b = s.buckets[t + 1 + k];
    relHi[k] = b.avgHigh ? Math.log(b.avgHigh) - ref : NaN;
    hv[k] = b.highVol;
    relLo[k] = b.avgLow ? Math.log(b.avgLow) - ref : NaN;
    lv[k] = b.lowVol;
    if (b.avgLow) endLo = relLo[k];
    if (b.avgHigh) endHi = relHi[k];
  }
  if (Number.isNaN(endLo)) endLo = s.lo[t + H] - ref;
  if (Number.isNaN(endHi)) endHi = s.hi[t + H] - ref;
  let peak = -Infinity, trough = Infinity;
  for (let k = 0; k < H; k++) {
    for (const v of [relHi[k], relLo[k]]) if (!Number.isNaN(v)) { peak = Math.max(peak, v); trough = Math.min(trough, v); }
  }
  return { relHi, hv, relLo, lv, endLo, endHi, peak, trough };
}

// Seconds until an offer at relative price x fills `need` units, or Infinity.
// A sell fills from trades at >= x, a buy from trades at <= x.
function fillTime(fut, x, need, share, step, side = 'sell') {
  let cum = 0;
  const ok = side === 'sell' ? (v) => v >= x : (v) => v <= x;
  for (let k = 0; k < fut.relHi.length; k++) {
    const v = share * ((ok(fut.relHi[k]) ? fut.hv[k] : 0) + (ok(fut.relLo[k]) ? fut.lv[k] : 0));
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
  }

  // items: [{ name, series5m, series1h }] for everything tracked.
  // Rebuilt when `version` changes (i.e. every price refresh).
  dataset(items, version, step, H) {
    const key = `${step}:${H}`;
    const hit = this.cache.get(key);
    if (hit && hit.version === version) return hit;
    const series = [];
    const rows = [];
    for (const it of items) {
      const buckets = step === 300 ? it.series5m : it.series1h;
      if (!buckets || buckets.length < LOOKBACK + H + 10) continue;
      const s = prepare(it.name, buckets, step);
      const si = series.push(s) - 1;
      // Neighbouring 5-minute moments are near-duplicates; every other one is plenty.
      const stride = step === 300 ? 2 : 1;
      for (let t = LOOKBACK; t + H < buckets.length; t += stride) {
        const f = features(s, t);
        if (f) rows.push({ si, t, f });
      }
    }
    // standardise each feature so no single one dominates the distance
    const dim = rows.length ? rows[0].f.length : 0;
    const mean = new Float64Array(dim), sd = new Float64Array(dim);
    for (const r of rows) for (let d = 0; d < dim; d++) mean[d] += r.f[d] / rows.length;
    for (const r of rows) for (let d = 0; d < dim; d++) sd[d] += (r.f[d] - mean[d]) ** 2 / rows.length;
    for (let d = 0; d < dim; d++) sd[d] = Math.sqrt(sd[d]) || 1;
    const X = new Float64Array(rows.length * dim);
    rows.forEach((r, i) => { for (let d = 0; d < dim; d++) X[i * dim + d] = (r.f[d] - mean[d]) / sd[d]; });
    const ds = { version, step, H, series, rows, X, dim, mean, sd,
      backtest: (hit && hit.backtest) || {}, bestK: (hit && hit.bestK) || {}, memo: new Map(), nbrMemo: new Map() };
    this.cache.set(key, ds);
    return ds;
  }

  neighbours(ds, f, filter, k = K) {
    const q = f.map((v, d) => (v - ds.mean[d]) / ds.sd[d]);
    const best = []; // [dist, idx], kept sorted, size <= k
    for (let i = 0; i < ds.rows.length; i++) {
      if (filter && !filter(ds.rows[i])) continue;
      let dist = 0;
      for (let d = 0; d < ds.dim; d++) {
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
      return { fut, need: qtyRel * s.typVol, w: 1 / (1 + Math.sqrt(dist)) };
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
    const withTimes = (r) => {
      const times = futs.map((n) => fillTime(n.fut, r.x, n.need, share, ds.step, side)).filter(Number.isFinite).sort((a, b) => a - b);
      return { ...r,
        median: times.length ? times[Math.floor(times.length / 2)] : Infinity,
        p90: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.9))] : Infinity };
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
    const buckets = step === 300 ? item.series5m : item.series1h;
    if (!buckets || buckets.length < LOOKBACK + 2) return null;
    const ds = this.dataset(items, version, step, H);
    if (ds.rows.length < MIN_SAMPLES) return null;
    const memoKey = `${side}:${item.name}:${qty}:${share}:${riskAversion}:${calibrate ? calibrate.samples : 0}`;
    if (ds.memo.has(memoKey)) return ds.memo.get(memoKey);
    const s = prepare(item.name, buckets, step);
    const t = buckets.length - 1;
    const f = features(s, t);
    if (!f) return null;
    // Anchor on the live market when it's fresh, else the chart's last prices.
    const l = item.latest || {};
    const now = Date.now() / 1000;
    const refLog = l.high && now - (l.highTime || 0) < FRESH ? Math.log(l.high) : s.hi[t];
    const lowLog = l.low && now - (l.lowTime || 0) < FRESH ? Math.log(l.low) : s.lo[t];
    // The similar-chart search depends only on the chart, so share it across
    // quantities, risk settings and both sides.
    const k = ds.bestK[side] || K;
    const nk = `${item.name}:${k}`;
    let nbrs = ds.nbrMemo.get(nk);
    if (!nbrs) {
      nbrs = this.neighbours(ds, f, (r) => !(ds.series[r.si].key === item.name && r.t > t - H), k);
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
      median: d.best.median,
      p90: d.best.p90,
      expected: d.best.ev,  // sell: expected net per unit; buy: expected cost per unit
      bad: d.best.bad,      // average of the worst 20% of outcomes
      riskAversion,
      rule: { price: d.rule.price, pFill: d.rule.pFill, pRaw: d.rule.pRaw, expected: d.rule.ev },
      curve: d.curve.map((c) => ({ price: c.price, ev: c.ev, pFill: c.pFill })),
      range: d.range,
      neighbours: nbrs.length,
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
    const acc = new Map(K_CHOICES.map((k) => [k, { n: 0, gain: 0, wins: 0, pred: 0, real: 0 }]));
    for (let i = 0; i < tests.length; i += stride) {
      const r = tests[i];
      const s = ds.series[r.si];
      const all = this.neighbours(ds, r.f, (c) => c.t + H < split.get(c.si), maxK);
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
      for (const k of K_CHOICES) {
        const nbrs = all.slice(0, k);
        if (nbrs.length < 10) continue;
        const d = this.decide(ds, nbrs, refLog, lowLog, qtyRel, share, s.key, { side, riskAversion });
        const a = realised(d.best.x);
        const gain = (sell ? a.v - ruleV : ruleV - a.v) / base; // positive = AI did better
        const m = acc.get(k);
        m.gain += gain; m.n++;
        if (gain >= 0) m.wins++;
        m.pred += d.best.pFill;
        m.real += a.filled ? 1 : 0;
      }
    }
    let bestK = null;
    const byK = {};
    for (const [k, m] of acc) {
      if (!m.n) continue;
      byK[k] = m.gain / m.n;
      if (bestK == null || byK[k] > byK[bestK]) bestK = k;
    }
    if (bestK == null) return null;
    const m = acc.get(bestK);
    const res = {
      side,
      tests: m.n,
      windowSec,
      k: bestK,
      byK,
      uplift: m.gain / m.n, // fraction of price better than the simple rule
      winRate: m.wins / m.n,
      predictedFill: m.pred / m.n,
      actualFill: m.real / m.n,
      samples: ds.rows.length,
      at: Date.now(),
    };
    ds.backtest[side] = res;
    ds.bestK[side] = bestK;
    ds.memo.clear();
    ds.nbrMemo.clear();
    return res;
  }
}

module.exports = { PriceAI, features, prepare, future, fillTime, tailMean, tailMeanSorted, K_CHOICES, stepFor };
