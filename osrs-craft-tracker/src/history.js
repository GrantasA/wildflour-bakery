'use strict';

const fs = require('fs');
const path = require('path');

// Saves price history to disk so the app's memory grows past what the Wiki API
// hands out (about 30 hours of 5-minute and 15 days of hourly data) and
// survives restarts. Append-only JSONL files, compacted now and then:
//
//   history-5m.jsonl  [id, ts, avgHigh, highVol, avgLow, lowVol]
//   history-1h.jsonl  same, hourly
//   ticks.jsonl       [id, bucketTs, 'h'|'l', price]   one line per trade price seen

class HistoryFiles {
  constructor(dir, suffix = '') {
    this.dir = dir;
    this.file = {
      '5m': path.join(dir, `history-5m${suffix}.jsonl`),
      '1h': path.join(dir, `history-1h${suffix}.jsonl`),
      ticks: path.join(dir, `ticks${suffix}.jsonl`),
    };
    this.pending = { '5m': [], '1h': [], ticks: [] };
    fs.mkdirSync(dir, { recursive: true });
  }

  // PriceStore hooks. Buffered and flushed by flush() (called every refresh).
  records(step, recs) {
    for (const [id, r] of recs) {
      this.pending[step].push(JSON.stringify([id, r.timestamp, r.avgHighPrice ?? null, r.highPriceVolume || 0,
        r.avgLowPrice ?? null, r.lowPriceVolume || 0]));
    }
  }

  tick(id, bucket, side, price) {
    this.pending.ticks.push(JSON.stringify([id, bucket, side, price]));
  }

  flush() {
    for (const k of Object.keys(this.pending)) {
      if (!this.pending[k].length) continue;
      fs.appendFileSync(this.file[k], this.pending[k].join('\n') + '\n');
      this.pending[k] = [];
    }
  }

  // Load everything saved into a PriceStore.
  loadInto(store) {
    for (const step of ['5m', '1h']) {
      const recs = [];
      for (const a of readLines(this.file[step])) {
        recs.push([a[0], { timestamp: a[1], avgHighPrice: a[2], highPriceVolume: a[3], avgLowPrice: a[4], lowPriceVolume: a[5] }]);
      }
      store.loadRecords(step, recs);
    }
    let ticks = 0;
    for (const [id, bucket, side, price] of readLines(this.file.ticks)) {
      store.addTick(id, bucket, side, price, false);
      ticks++;
    }
    store.prune('5m');
    return ticks;
  }

  // Rewrite the files with only what the store still retains.
  compact(store) {
    this.flush();
    for (const step of ['5m', '1h']) {
      const lines = [];
      for (const [id, recs] of store.raw[step]) {
        for (const r of recs.values()) {
          lines.push(JSON.stringify([id, r.timestamp, r.avgHighPrice ?? null, r.highPriceVolume || 0,
            r.avgLowPrice ?? null, r.lowPriceVolume || 0]));
        }
      }
      writeAtomic(this.file[step], lines);
    }
    const tl = [];
    for (const [id, byBucket] of store.ticks) {
      for (const [bucket, b] of byBucket) {
        for (const side of ['h', 'l']) {
          for (const [price, count] of b[side]) for (let i = 0; i < count; i++) tl.push(JSON.stringify([id, bucket, side, price]));
        }
      }
    }
    writeAtomic(this.file.ticks, tl);
  }
}

function readLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* torn last line after a crash */ }
  }
  return out;
}

function writeAtomic(file, lines) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
  fs.renameSync(tmp, file);
}

module.exports = { HistoryFiles };
