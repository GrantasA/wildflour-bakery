'use strict';

// Risk assessment.
//
// 1. Price-move risk over the whole craft cycle. While you spend hours buying
//    ingredients, the product's price can move. From the product's own history
//    we measure how much its price has moved over stretches as long as your
//    cycle (de-meaned, so we model the size of swings, not a trend guess) and
//    derive a "bad case" (10th percentile) and the chance of making a loss.
//
// 2. Warning signs: a price far from its recent norm (spike, crash or
//    manipulation of a thin item), and items that barely trade.
//
// The risk comfort setting (careful / balanced / bold) decides how much the bad
// case counts when plans and prices are chosen.

// low risk = weigh the bad case fully; high risk = chase the average
const RISK_LEVELS = { low: 1, mid: 0.4, high: 0, careful: 1, balanced: 0.4, bold: 0 };
const NORMAL_Q10 = -1.2816;

function logMid(buckets) {
  let lastH = NaN, lastL = NaN;
  return buckets.map((b) => {
    if (b.avgHigh) lastH = Math.log(b.avgHigh);
    if (b.avgLow) lastL = Math.log(b.avgLow);
    if (Number.isNaN(lastH)) return lastL;
    if (Number.isNaN(lastL)) return lastH;
    return (lastH + lastL) / 2;
  });
}

// Sorted, de-meaned log returns over `horizonSec`, from the best-fitting series.
function horizonReturns(item, horizonSec) {
  const cacheKey = Math.round(horizonSec / 300);
  item._riskCache = item._riskCache || new Map();
  if (item._riskCache.has(cacheKey)) return item._riskCache.get(cacheKey);
  let out = null;
  for (const [buckets, step] of [[item.series5m, 300], [item.series1h, 3600]]) {
    if (!buckets || buckets.length < 30) continue;
    const lag = Math.max(1, Math.round(horizonSec / step));
    if (buckets.length - lag < 30) continue;
    const m = logMid(buckets);
    const r = [];
    for (let t = 0; t + lag < m.length; t++) {
      const d = m[t + lag] - m[t];
      if (Number.isFinite(d)) r.push(d);
    }
    if (r.length < 30) continue;
    const mean = r.reduce((a, v) => a + v, 0) / r.length;
    out = { returns: r.map((v) => v - mean).sort((a, b) => a - b), source: step === 300 ? '5m' : '1h' };
    break;
  }
  if (!out) {
    // Not enough history for this horizon: scale up short-term volatility.
    const buckets = (item.series5m && item.series5m.length > 30) ? item.series5m : item.series1h;
    if (buckets && buckets.length > 30) {
      const step = buckets === item.series5m ? 300 : 3600;
      const m = logMid(buckets);
      const d = [];
      for (let t = 1; t < m.length; t++) if (Number.isFinite(m[t] - m[t - 1])) d.push(m[t] - m[t - 1]);
      const mu = d.reduce((a, v) => a + v, 0) / Math.max(1, d.length);
      const sd = Math.sqrt(d.reduce((a, v) => a + (v - mu) ** 2, 0) / Math.max(1, d.length));
      out = { sigma: sd * Math.sqrt(horizonSec / step), source: 'scaled' };
    }
  }
  item._riskCache.set(cacheKey, out);
  return out;
}

function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
}

function normCdf(z) {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// How the product's price could move over `horizonSec`.
//   q10: log move in the worst 10% of cases; probBelow(x): P(move < x)
function priceMoveRisk(item, horizonSec) {
  const h = horizonReturns(item, horizonSec);
  if (!h) return null;
  if (h.returns) {
    const r = h.returns;
    return {
      q10: quantile(r, 0.1), q90: quantile(r, 0.9), source: h.source,
      probBelow: (x) => {
        let lo = 0, hi = r.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (r[mid] < x) lo = mid + 1; else hi = mid; }
        return lo / r.length;
      },
    };
  }
  const s = Math.max(1e-6, h.sigma);
  return { q10: NORMAL_Q10 * s, q90: -NORMAL_Q10 * s, source: h.source, probBelow: (x) => normCdf(x / s) };
}

// Warning signs for an item. Returns a list of short human-readable flags.
function warnings(item, nowSec = Date.now() / 1000) {
  const out = [];
  const s = item.series5m || [];
  const l = item.latest || {};
  if (s.length >= 48) {
    const day = s.slice(-288);
    const vol = day.reduce((a, b) => a + b.highVol + b.lowVol, 0);
    const hours = (day.length * 300) / 3600;
    if (vol < 10 * (hours / 24)) out.push({ kind: 'thin', text: `very thin: ~${Math.round((vol * 24) / hours)} trades/day` });
    const highs = day.map((b) => b.avgHigh).filter(Boolean).sort((a, b) => a - b);
    if (highs.length >= 12 && l.high && nowSec - (l.highTime || 0) < 3 * 3600) {
      const med = highs[Math.floor(highs.length / 2)];
      const m = logMid(day);
      const d = [];
      for (let t = 1; t < m.length; t++) if (Number.isFinite(m[t] - m[t - 1])) d.push(Math.abs(m[t] - m[t - 1]));
      d.sort((a, b) => a - b);
      const typical = d.length ? d[Math.floor(d.length / 2)] * 1.4826 : 0.01; // robust per-bucket volatility
      const dev = Math.log(l.high / med);
      const limit = Math.max(0.06, 6 * typical * Math.sqrt(12));
      if (dev > limit) out.push({ kind: 'spike', text: `price spike: ${Math.round(dev * 100)}% above its 24h median (possible manipulation)` });
      if (dev < -limit) out.push({ kind: 'crash', text: `price crash: ${Math.round(-dev * 100)}% below its 24h median` });
    }
  }
  return out;
}

module.exports = { RISK_LEVELS, priceMoveRisk, warnings, horizonReturns };
