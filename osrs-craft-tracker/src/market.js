'use strict';

// Fill-time model.
//
// The Wiki price API gives, per time bucket (5 minutes or 1 hour):
//   avgHighPrice / highPriceVolume: trades where a buyer paid a seller's ask ("insta-buy")
//   avgLowPrice  / lowPriceVolume:  trades where a seller dumped into a bid ("insta-sell")
//
// A buy offer at price P fills from any seller who was willing to sell at <= P,
// so the supply available to it in a bucket is the volume that traded at <= P
// on either side. A sell offer at S fills from buyers who paid >= S. We only
// get to capture a share of that flow because other players compete for it.
//
// To get a *median* wait we replay history: start the offer at every bucket in
// the window, walk forward until the captured volume covers the quantity, and
// take the median of those elapsed times. The window is treated as cyclic so
// starts near the end aren't cut short, and quantities larger than a whole
// window's volume extrapolate over repeated cycles.

const FOUR_HOURS = 4 * 3600;
const MIN_FILL_SECONDS = 60;
// Bucket averages hide the spread inside a bucket, so price membership is a
// linear ramp +/- this fraction around the bucket average instead of a hard cut.
const PRICE_SPREAD = 0.01;
const detrendCache = new WeakMap(); // normalized series array -> detrended copy

function normalizeSeries(raw, stepSec, maxPoints = 365) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const byTs = new Map();
  for (const r of raw) byTs.set(r.timestamp, r);
  const last = Math.max(...byTs.keys());
  const first = Math.max(Math.min(...byTs.keys()), last - (maxPoints - 1) * stepSec);
  const out = [];
  for (let ts = first; ts <= last; ts += stepSec) {
    const r = byTs.get(ts);
    out.push({
      ts,
      avgHigh: r && r.avgHighPrice != null ? r.avgHighPrice : null,
      highVol: r && r.highPriceVolume ? r.highPriceVolume : 0,
      avgLow: r && r.avgLowPrice != null ? r.avgLowPrice : null,
      lowVol: r && r.lowPriceVolume ? r.lowPriceVolume : 0,
    });
  }
  return out;
}

function ramp(x) {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

function fracAtOrBelow(avg, price) {
  if (avg == null) return 0;
  const w = Math.max(1, avg * PRICE_SPREAD);
  return ramp((price - (avg - w)) / (2 * w));
}

function fracAtOrAbove(avg, price) {
  if (avg == null) return 0;
  const w = Math.max(1, avg * PRICE_SPREAD);
  return ramp((avg + w - price) / (2 * w));
}

// Volume per bucket that an offer at `price` could have matched.
function matchableVolumes(buckets, side, price) {
  return buckets.map((b) =>
    side === 'buy'
      ? b.lowVol * fracAtOrBelow(b.avgLow, price) + b.highVol * fracAtOrBelow(b.avgHigh, price)
      : b.highVol * fracAtOrAbove(b.avgHigh, price) + b.lowVol * fracAtOrAbove(b.avgLow, price));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return Infinity;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

// Median and 90th percentile seconds to fill `qty` given per-bucket volumes.
function fillTimeStats(volumes, qty, share, stepSec) {
  const n = volumes.length;
  if (n === 0 || qty <= 0) return { median: Infinity, p90: Infinity };
  const cum = new Float64Array(2 * n + 1);
  for (let i = 0; i < 2 * n; i++) cum[i + 1] = cum[i] + share * volumes[i % n];
  const total = cum[n];
  if (total <= 0) return { median: Infinity, p90: Infinity };

  let cycles = Math.floor(qty / total);
  let rem = qty - cycles * total;
  if (rem <= 1e-9) { cycles -= 1; rem = total; }

  const times = new Array(n);
  for (let s = 0; s < n; s++) {
    // smallest j in [s, s+n) with cum[j+1] - cum[s] >= rem
    let lo = s, hi = s + n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid + 1] - cum[s] >= rem) hi = mid; else lo = mid + 1;
    }
    const inBucket = cum[lo + 1] - cum[lo];
    const frac = inBucket > 0 ? (rem - (cum[lo] - cum[s])) / inBucket : 1;
    times[s] = (cycles * n + (lo - s) + frac) * stepSec;
  }
  times.sort((a, b) => a - b);
  return { median: percentile(times, 0.5), p90: percentile(times, 0.9) };
}

// The GE buy limit caps how many you can buy per 4 hours, whatever the price.
function buyLimitSeconds(qty, limit) {
  if (!limit || qty <= limit) return 0;
  return Math.floor((qty - 1) / limit) * FOUR_HOURS;
}

// Shift history onto today's price level. Replaying 15 days of hourly data for
// an item that has drifted 10% would otherwise suggest prices from a different
// market. Each bucket is scaled by (current mid / rolling mid around it), which
// keeps the short-term swings (what patient offers catch) but removes the trend.
function detrend(buckets, latest, window = 24) {
  const mids = buckets.map((b) => {
    const xs = [b.avgHigh, b.avgLow].filter((x) => x != null);
    return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
  });
  const known = mids.filter((m) => m != null);
  if (known.length < 3) return buckets;
  const current = latest && latest.high && latest.low ? (latest.high + latest.low) / 2 : null;
  const rolling = mids.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(mids.length - 1, i + window); j++) {
      if (mids[j] != null) { sum += mids[j]; cnt++; }
    }
    return cnt ? sum / cnt : null;
  });
  const lastRolling = [...rolling].reverse().find((r) => r != null);
  const target = current || lastRolling;
  return buckets.map((b, i) => {
    const k = rolling[i] ? target / rolling[i] : 1;
    return {
      ...b,
      avgHigh: b.avgHigh != null ? b.avgHigh * k : null,
      avgLow: b.avgLow != null ? b.avgLow * k : null,
    };
  });
}

// Pick the series to model with: 5-minute buckets (last ~30h) when the item
// trades enough, otherwise hourly buckets (last ~15 days) for thin markets.
function pickSeries(item, qty) {
  const s5 = item.series5m || [];
  const s1 = item.series1h || [];
  const vol = (s) => s.reduce((a, b) => a + b.highVol + b.lowVol, 0);
  const active5 = s5.filter((b) => b.highVol + b.lowVol > 0).length;
  let pick = null;
  if (s5.length && active5 >= 12 && vol(s5) >= 2 * qty) pick = { buckets: s5, step: 300, label: '5m' };
  else if (s1.length) pick = { buckets: s1, step: 3600, label: '1h' };
  else if (s5.length) pick = { buckets: s5, step: 300, label: '5m' };
  if (!pick) return null;
  const cacheKey = pick.buckets;
  if (!detrendCache.has(cacheKey) || detrendCache.get(cacheKey).latest !== item.latest) {
    detrendCache.set(cacheKey, { latest: item.latest, buckets: detrend(pick.buckets, item.latest) });
  }
  return { ...pick, buckets: detrendCache.get(cacheKey).buckets };
}

function candidatePrices(buckets, latest) {
  const pts = [];
  for (const b of buckets) {
    if (b.avgLow != null && b.lowVol) pts.push([b.avgLow, b.lowVol]);
    if (b.avgHigh != null && b.highVol) pts.push([b.avgHigh, b.highVol]);
  }
  const out = new Set();
  if (pts.length) {
    pts.sort((a, b) => a[0] - b[0]);
    const total = pts.reduce((a, p) => a + p[1], 0);
    let acc = 0, q = 0;
    const levels = [];
    for (let l = 0; l <= 1.0001; l += 0.04) levels.push(l);
    for (const [price, vol] of pts) {
      acc += vol;
      while (q < levels.length && acc / total >= levels[q]) { out.add(Math.round(price)); q++; }
    }
    out.add(Math.round(pts[0][0]));
    out.add(Math.round(pts[pts.length - 1][0]));
  }
  if (latest) {
    if (latest.low) out.add(latest.low);
    if (latest.high) out.add(latest.high);
  }
  return [...out].filter((p) => p > 0).sort((a, b) => a - b);
}

// Price -> median fill time curve for buying or selling `qty` of an item,
// reduced to the Pareto frontier (you never want a slower AND worse price).
function priceCurve(item, side, qty, opts) {
  const pick = pickSeries(item, qty);
  if (!pick) return { points: [], series: null };
  const limitSec = side === 'buy' ? buyLimitSeconds(qty, item.limit) : 0;
  const points = candidatePrices(pick.buckets, item.latest).map((price) => {
    const vols = matchableVolumes(pick.buckets, side, price);
    const st = fillTimeStats(vols, qty, opts.share, pick.step);
    return {
      price,
      median: Math.max(MIN_FILL_SECONDS, st.median, limitSec),
      p90: Math.max(MIN_FILL_SECONDS, st.p90, limitSec),
    };
  }).filter((p) => Number.isFinite(p.median));

  points.sort((a, b) => a.median - b.median || (side === 'buy' ? a.price - b.price : b.price - a.price));
  const frontier = [];
  for (const p of points) {
    const prev = frontier[frontier.length - 1];
    if (!prev || (side === 'buy' ? p.price < prev.price : p.price > prev.price)) frontier.push(p);
  }
  return { points: frontier, series: pick.label };
}

function fillAt(item, side, qty, price, opts) {
  const pick = pickSeries(item, qty);
  if (!pick || !price) return { median: Infinity, p90: Infinity };
  const st = fillTimeStats(matchableVolumes(pick.buckets, side, price), qty, opts.share, pick.step);
  const limitSec = side === 'buy' ? buyLimitSeconds(qty, item.limit) : 0;
  return {
    median: Math.max(MIN_FILL_SECONDS, st.median, limitSec),
    p90: Math.max(MIN_FILL_SECONDS, st.p90, limitSec),
  };
}

module.exports = {
  normalizeSeries, matchableVolumes, fillTimeStats, buyLimitSeconds,
  pickSeries, detrend, candidatePrices, priceCurve, fillAt, FOUR_HOURS, MIN_FILL_SECONDS,
};
