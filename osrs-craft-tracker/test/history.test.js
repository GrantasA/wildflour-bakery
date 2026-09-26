'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { PriceStore } = require('../src/prices');
const { HistoryFiles } = require('../src/history');
const { matchableVolumes, normalizeSeries } = require('../src/market');
const { outcome } = require('../src/journal');

// A fake Wiki API: one item, a fixed series, and a /latest we can change.
function fakeApi(latest) {
  const now = 1_800_000_000 - (1_800_000_000 % 300);
  const series = Array.from({ length: 50 }, (_, k) => ({
    timestamp: now - (49 - k) * 300, avgHighPrice: 1000, highPriceVolume: 5, avgLowPrice: 990, lowPriceVolume: 5 }));
  return async (url) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^.*\/osrs/, '');
    const body = p === '/mapping' ? [{ id: 1, name: 'Thing', limit: 100 }]
      : p === '/latest' ? { data: { 1: latest() } }
      : p === '/timeseries' ? { data: series }
      : p === '/5m' ? { data: {}, timestamp: now - 300 } : { data: {} };
    return { ok: true, status: 200, json: async () => body };
  };
}

test('history and trade prices survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  let l = { high: 1000, highTime: 1_799_999_000, low: 990, lowTime: 1_799_999_000 };
  const files = new HistoryFiles(dir);
  const a = new PriceStore({ userAgent: 't', fetchImpl: fakeApi(() => l), persist: files });
  await a.loadMapping();
  await a.backfill(1, '5m');
  await a.pollTicks();
  l = { ...l, high: 1040, highTime: 1_799_999_100 }; // a buyer paid 1040
  assert.strictEqual(await a.pollTicks(), 1);
  assert.strictEqual(await a.pollTicks(), 0, 'unchanged price is not a new trade');
  files.flush();

  const b = new PriceStore({ userAgent: 't', fetchImpl: fakeApi(() => l), persist: new HistoryFiles(dir) });
  b.persist.loadInto(b);
  assert.strictEqual(b.raw['5m'].get(1).size, 50);
  const s = b.series(1, '5m');
  const withTicks = s.filter((x) => x.hiTicks);
  assert.ok(withTicks.length >= 1);
  assert.ok(withTicks.some((x) => x.hiTicks.some(([p]) => p === 1040)));
  // compaction keeps the same data
  b.persist.compact(b);
  const c = new PriceStore({ userAgent: 't', persist: new HistoryFiles(dir) });
  c.persist.loadInto(c);
  assert.strictEqual(c.raw['5m'].get(1).size, 50);
  assert.strictEqual(c.tickCount, b.tickCount);
});

test('exact trade prices count towards fills when the average falls short', () => {
  const buckets = normalizeSeries([{ timestamp: 0, avgHighPrice: 1000, highPriceVolume: 10, avgLowPrice: 990, lowPriceVolume: 10 }], 300);
  // selling at 1030: the averages never got there
  assert.strictEqual(matchableVolumes(buckets, 'sell', 1030)[0], 0);
  buckets[0].hiTicks = [[1000, 3], [1035, 2]]; // but two trades happened at 1035
  assert.strictEqual(matchableVolumes(buckets, 'sell', 1030)[0], 2);
  assert.strictEqual(outcome(buckets, 1030, 1, 1, 300, 'sell').hit, true);
  assert.strictEqual(outcome(buckets, 1030, 3, 1, 300, 'sell').hit, false);
});
