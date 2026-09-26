'use strict';

const { taxPerItem } = require('./tax');

// Sell-price AI: analog ("nearest neighbour") forecasting on price charts.
//
// For the item you want to sell, it describes the current chart as a feature
// vector (recent shape relative to now, volatility, position in its recent
// range, volume trend, spread, time of day). It then searches the history of
// every tracked item for the moments whose charts looked most similar and
// replays what actually happened in the following window: how high buyers
// paid, how much volume traded, and what the price was at the end.
//
// For each candidate sell price it gets, from those similar moments:
//   P(sells within the window)   and   what you'd get by dumping if it doesn't.
// It picks the price with the best expected payout after GE tax.
//
// It also backtests itself on the most recent history it didn't train on, so
// the dashboard can show whether it beats "undercut the market by 1gp".

const LAGS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 24];
const LOOKBACK = 24;
const K = 60;
const GRID = 48;
const MIN_SAMPLES = 400;

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

// What happened after moment t, relative to the price then.
function future(s, t, H) {
  const relHi = new Float64Array(H), hv = new Float64Array(H), relLo = new Float64Array(H), lv = new Float64Array(H);
  const ref = s.hi[t];
  let endLo = NaN;
  for (let k = 0; k < H; k++) {
    const b = s.buckets[t + 1 + k];
    relHi[k] = b.avgHigh ? Math.log(b.avgHigh) - ref : -Infinity;
    hv[k] = b.highVol;
    relLo[k] = b.avgLow ? Math.log(b.avgLow) - ref : -Infinity;
    lv[k] = b.lowVol;
    if (b.avgLow) endLo = relLo[k];
  }
  if (Number.isNaN(endLo)) endLo = s.lo[t + H] - ref;
  let peak = -Infinity;
  for (let k = 0; k < H; k++) peak = Math.max(peak, relHi[k], relLo[k]);
  return { relHi, hv, relLo, lv, endLo, peak };
}

// Seconds until a sell offer at relative price x fills `need` units, or Infinity.
function fillTime(fut, x, need, share, step) {
  let cum = 0;
  for (let k = 0; k < fut.relHi.length; k++) {
    const v = share * ((fut.relHi[k] >= x ? fut.hv[k] : 0) + (fut.relLo[k] >= x ? fut.lv[k] : 0));
    if (cum + v >= need) return (k + (v > 0 ? (need - cum) / v : 1)) * step;
    cum += v;
  }
  return Infinity;
}

class SellAI {
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
      for (let t = LOOKBACK; t + H < buckets.length; t++) {
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
    const ds = { version, step, H, series, rows, X, dim, mean, sd, backtest: hit && hit.backtest, backtestAt: hit && hit.backtestAt };
    this.cache.set(key, ds);
    return ds;
  }

  neighbours(ds, f, filter) {
    const q = f.map((v, d) => (v - ds.mean[d]) / ds.sd[d]);
    const best = []; // [dist, idx], kept sorted, size <= K
    for (let i = 0; i < ds.rows.length; i++) {
      if (filter && !filter(ds.rows[i])) continue;
      let dist = 0;
      for (let d = 0; d < ds.dim; d++) {
        const z = ds.X[i * ds.dim + d] - q[d];
        dist += z * z;
        if (best.length === K && dist >= best[K - 1][0]) break;
      }
      if (best.length < K || dist < best[best.length - 1][0]) {
        best.push([dist, i]);
        best.sort((a, b) => a[0] - b[0]);
        if (best.length > K) best.pop();
      }
    }
    return best.map(([dist, i]) => ({ dist, row: ds.rows[i] }));
  }

  // Core decision: given neighbours' futures, choose the sell price.
  decide(ds, nbrs, refLog, lowLog, qtyRel, share, itemName) {
    const futs = nbrs.map(({ dist, row }) => {
      const s = ds.series[row.si];
      return { fut: future(s, row.t, ds.H), need: qtyRel * s.typVol, w: 1 / (1 + Math.sqrt(dist)) };
    });
    const wsum = futs.reduce((a, n) => a + n.w, 0);
    const peaks = futs.map((n) => n.fut.peak).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (p) => (peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(p * peaks.length))] : 0);
    const lo = Math.min(lowLog - refLog, 0) - 0.005;
    const hi = Math.max(q(0.9), 0.001);
    const net = (x) => { const S = Math.round(Math.exp(refLog + x)); return S - taxPerItem(S, itemName); };
    const evalAt = (x) => {
      let ev = 0, pFill = 0;
      const times = [];
      for (const n of futs) {
        const t = fillTime(n.fut, x, n.need, share, ds.step);
        if (Number.isFinite(t)) { ev += n.w * net(x); pFill += n.w; times.push(t); } else ev += n.w * net(n.fut.endLo);
      }
      times.sort((a, b) => a - b);
      return { x, ev: ev / wsum, pFill: pFill / wsum,
        median: times.length ? times[Math.floor(times.length / 2)] : Infinity,
        p90: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.9))] : Infinity };
    };
    let best = null;
    const curve = [];
    for (let g = 0; g <= GRID; g++) {
      const r = evalAt(lo + ((hi - lo) * g) / GRID);
      curve.push(r);
      if (!best || r.ev > best.ev) best = r;
    }
    const undercut = evalAt(Math.log(Math.max(1, Math.exp(refLog) - 1)) - refLog);
    const dump = futs.reduce((a, n) => a + n.w * net(n.fut.endLo), 0) / wsum;
    return {
      best, undercut, dump, curve,
      peaks: { q25: Math.round(Math.exp(refLog + q(0.25))), q50: Math.round(Math.exp(refLog + q(0.5))), q75: Math.round(Math.exp(refLog + q(0.75))) },
    };
  }

  // Suggest a sell price for `qty` of `item` to sell within `windowSec`.
  suggest(items, version, item, qty, windowSec, share) {
    const step = windowSec <= 6 * 3600 ? 300 : 3600;
    const H = Math.max(1, Math.min(96, Math.round(windowSec / step)));
    const buckets = step === 300 ? item.series5m : item.series1h;
    if (!buckets || buckets.length < LOOKBACK + 2) return null;
    const ds = this.dataset(items, version, step, H);
    if (ds.rows.length < MIN_SAMPLES) return null;
    const s = prepare(item.name, buckets, step);
    const t = buckets.length - 1;
    const f = features(s, t);
    if (!f) return null;
    // Anchor on the live market price when it's fresh, else the chart's last price.
    const l = item.latest || {};
    const refLog = l.high && Date.now() / 1000 - (l.highTime || 0) < 2 * 3600 ? Math.log(l.high) : s.hi[t];
    const lowLog = l.low ? Math.log(l.low) : s.lo[t];
    const nbrs = this.neighbours(ds, f, (r) => !(ds.series[r.si].key === item.name && r.t > t - H));
    if (nbrs.length < 10) return null;
    const d = this.decide(ds, nbrs, refLog, lowLog, qty / s.typVol, share, item.name);
    const price = Math.round(Math.exp(refLog + d.best.x));
    return {
      source: 'ai',
      price,
      pFill: d.best.pFill,
      median: d.best.median,
      p90: d.best.p90,
      expectedNet: d.best.ev,
      undercut: { price: Math.max(1, Math.round(Math.exp(refLog)) - 1), pFill: d.undercut.pFill, expectedNet: d.undercut.ev },
      dumpNet: d.dump,
      curve: d.curve.map((c) => ({ price: Math.round(Math.exp(refLog + c.x)), ev: c.ev, pFill: c.pFill })),
      peaks: d.peaks,
      neighbours: nbrs.length,
      windowSec,
      spark: buckets.slice(-Math.min(buckets.length, step === 300 ? 144 : 72))
        .map((b) => [b.ts, b.avgHigh, b.avgLow]),
      backtest: ds.backtest || null,
    };
  }

  // Walk-forward test: train on the older 75% of each series, test on the
  // newest 25%. Compares the AI's realised payout per unit against simply
  // undercutting the market by 1gp, and against instant-selling.
  runBacktest(items, version, windowSec, share, maxTests = 300) {
    const step = windowSec <= 6 * 3600 ? 300 : 3600;
    const H = Math.max(1, Math.min(96, Math.round(windowSec / step)));
    const ds = this.dataset(items, version, step, H);
    if (ds.rows.length < MIN_SAMPLES) return null;
    const split = new Map(ds.series.map((s, i) => [i, Math.floor(s.buckets.length * 0.75)]));
    const tests = ds.rows.filter((r) => r.t >= split.get(r.si));
    const stride = Math.max(1, Math.floor(tests.length / maxTests));
    let n = 0, ai = 0, uc = 0, inst = 0, wins = 0, predFill = 0, realFill = 0;
    for (let i = 0; i < tests.length; i += stride) {
      const r = tests[i];
      const s = ds.series[r.si];
      const nbrs = this.neighbours(ds, r.f, (c) => c.t + H < split.get(c.si));
      if (nbrs.length < 10) continue;
      const refLog = s.hi[r.t], lowLog = s.lo[r.t];
      const qtyRel = 0.5; // half a typical bucket's volume
      const d = this.decide(ds, nbrs, refLog, lowLog, qtyRel, share, s.key);
      const fut = future(s, r.t, H);
      const need = qtyRel * s.typVol;
      const realised = (x) => {
        const S = Math.round(Math.exp(refLog + (Number.isFinite(fillTime(fut, x, need, share, step)) ? x : fut.endLo)));
        return S - taxPerItem(S, s.key);
      };
      const base = Math.exp(refLog);
      const a = realised(d.best.x) / base;
      const u = realised(Math.log(Math.max(1, base - 1)) - refLog) / base;
      const iS = Math.round(Math.exp(lowLog));
      ai += a; uc += u; inst += (iS - taxPerItem(iS, s.key)) / base;
      if (a >= u) wins++;
      predFill += d.best.pFill;
      realFill += Number.isFinite(fillTime(fut, d.best.x, need, share, step)) ? 1 : 0;
      n++;
    }
    if (!n) return null;
    const res = {
      tests: n,
      windowSec,
      upliftVsUndercut: ai / n - uc / n, // fraction of price
      upliftVsInstant: ai / n - inst / n,
      winRate: wins / n,
      predictedFill: predFill / n,
      actualFill: realFill / n,
      samples: ds.rows.length,
      at: Date.now(),
    };
    ds.backtest = res;
    ds.backtestAt = Date.now();
    return res;
  }
}

module.exports = { SellAI, features, prepare, future, fillTime };
