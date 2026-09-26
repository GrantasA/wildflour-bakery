'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PriceStore } = require('./prices');
const { evaluateRecipe, DEFAULTS } = require('./optimizer');
const { PositionStore, stats, timingFactor } = require('./positions');
const { rankCrafts, advise } = require('./copilot');
const { PriceAI } = require('./ai');
const { Journal } = require('./journal');
const { RISK_LEVELS } = require('./risk');
const { HistoryFiles } = require('./history');
const { planSlots, inUse, explainEmpty, worthwhileFloor } = require('./portfolio');

const PORT = Number(process.env.PORT) || 3000;
// The page can create and edit your trades, so only listen on this machine.
const HOST = process.env.HOST || '127.0.0.1';
const POSITIONS_FILE = process.env.POSITIONS_FILE ||
  path.join(__dirname, '..', 'data', process.argv.includes('--mock') ? 'positions-mock.json' : 'positions.json');
const REFRESH_MS = 60_000;                // prices + viability every minute
// Poll the latest trade prices this often to catch exact trade prices
// (0 turns it off). Kept modest to stay polite to the Wiki API.
const TICK_MS = (process.env.TICK_SECONDS != null ? Number(process.env.TICK_SECONDS) : 10) * 1000;
const COMPACT_MS = 6 * 3600_000;
const HOURLY_BUCKET_MS = 10 * 60_000;
const BACKFILL_MAX_AGE_MS = 6 * 3600_000; // re-pull full history every 6h
const MAPPING_MAX_AGE_MS = 24 * 3600_000;
const RECIPES_FILE = process.env.RECIPES_FILE || path.join(__dirname, 'recipes.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1';
const USER_AGENT = process.env.OSRS_USER_AGENT ||
  'osrs-craft-profit-tracker/1.0 (personal GE crafting profit tool; set OSRS_USER_AGENT to add your contact)';

const fetchImpl = MOCK ? require('./mock').createMockFetch(() => loadRecipes().recipes) : globalThis.fetch;
const historyFiles = new HistoryFiles(path.dirname(POSITIONS_FILE), MOCK ? '-mock' : '');
const store = new PriceStore({ userAgent: USER_AGENT, fetchImpl, persist: historyFiles });
{
  const t0 = Date.now();
  const ticks = historyFiles.loadInto(store);
  const m = store.memoryStats();
  console.log(`Loaded saved history: ${m.days5m.toFixed(1)} days (5-min), ${m.days1h.toFixed(1)} days (hourly), ${ticks} trade prices in ${Date.now() - t0}ms`);
  historyFiles.compact(store);
}
const positions = new PositionStore(POSITIONS_FILE);
const priceAI = new PriceAI();
const DATA_DIR = path.dirname(POSITIONS_FILE);
const journal = new Journal(DATA_DIR, MOCK ? '-mock' : '');

// ---- price AI plumbing ----
// Windows are snapped to a few sizes so the AI's training sets can be reused.
const AI_WINDOWS = [5 / 60, 0.5, 1, 2, 4, 8, 12, 24, 48, 72].map((h) => Math.round(h * 3600));
const snapWindow = (sec) => AI_WINDOWS.find((w) => w >= sec) || AI_WINDOWS[AI_WINDOWS.length - 1];
const aiWindowsInUse = { sell: new Set([2 * 3600]), buy: new Set([4 * 3600]) };
const backtests = { sell: new Map(), buy: new Map() }; // side -> windowSec -> result

// The AI's training sets only change when a new 5-minute / hourly bucket lands.
const aiVersion = (step) => `${store.lastBucket[step === 300 ? '5m' : '1h']}:${aiItems().length}`;

let aiItemsCache = { version: -1, items: [] };
function aiItems() {
  if (aiItemsCache.version !== store.version) {
    const items = trackedIds().map((id) => store.getItem(store.byId.get(id).name)).filter(Boolean);
    aiItemsCache = { version: store.version, items };
  }
  return aiItemsCache.items;
}

// Safety switch: if the AI did worse than the simple rule in its latest
// backtest for this side and window, don't use it there.
const aiAllowed = (side, w) => {
  const bt = backtests[side].get(w);
  return !(bt && bt.uplift < 0);
};

function advisorFor(settings, side) {
  if (!settings.useAI) return null;
  return (item, qty, windowSec) => {
    const w = snapWindow(windowSec);
    aiWindowsInUse[side].add(w);
    if (!aiAllowed(side, w)) return null;
    try {
      const s = priceAI.suggest(aiItems(), aiVersion, item, qty, w, settings.share, {
        side, riskAversion: settings.riskAversion, calibrate: journal.calibrator(side),
      });
      // Write it down so it can be graded against the real chart later.
      if (s) journal.record({ item: item.name, windowSec: w, qty, share: settings.share, suggestion: s });
      return s;
    } catch (e) {
      logError('ai', e);
      return null;
    }
  };
}

function gradeJournal() {
  try {
    const n = journal.grade((name, windowSec) => {
      const it = store.getItem(name);
      if (!it) return null;
      return windowSec <= 6 * 3600 ? it.series5m : it.series1h;
    });
    if (n) resultsCache.clear();
  } catch (e) {
    logError('journal', e);
  }
}

let backtesting = false;
function runBacktests() {
  if (backtesting || !state.lastRefresh) return;
  backtesting = true;
  priceAI.setRecipes(loadRecipes().recipes);
  const jobs = [];
  for (const side of ['sell', 'buy']) for (const w of aiWindowsInUse[side]) jobs.push([side, w]);
  const next = () => {
    const job = jobs.shift();
    if (!job) { backtesting = false; resultsCache.clear(); return; }
    const [side, w] = job;
    try {
      const res = priceAI.runBacktest(aiItems(), aiVersion, w, DEFAULTS.share, { side });
      if (res) backtests[side].set(w, res);
    } catch (e) {
      logError('ai backtest', e);
    }
    setImmediate(next);
  };
  setImmediate(next);
}
setInterval(runBacktests, 10 * 60_000);

const state = {
  startedAt: Date.now(),
  lastRefresh: null,
  nextRefresh: null,
  mappingAt: 0,
  lastHourly: 0,
  errors: [],
  backfill: { done: 0, total: 0 },
};

let recipesCache = { mtime: 0, recipes: [] };
function loadRecipes() {
  const mtime = fs.statSync(RECIPES_FILE).mtimeMs;
  if (mtime !== recipesCache.mtime) {
    const { recipes } = JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf8'));
    recipesCache = { mtime, recipes };
  }
  return recipesCache;
}

function logError(where, err) {
  const msg = `${new Date().toISOString()} ${where}: ${err.message || err}`;
  console.error(msg);
  state.errors.unshift(msg);
  state.errors.length = Math.min(state.errors.length, 20);
}

function trackedIds() {
  const ids = new Set();
  for (const r of loadRecipes().recipes) {
    for (const name of [...r.inputs.map((i) => i.item), r.output.item]) {
      const m = store.resolve(name);
      if (m) ids.add(m.id);
    }
  }
  return [...ids];
}

// Pull full timeseries history for any tracked item that's new or stale.
// Runs a couple of requests at a time so we stay polite to the Wiki API.
let backfilling = false;
async function backfillPending() {
  if (backfilling) return;
  backfilling = true;
  try {
    const now = Date.now();
    const jobs = [];
    for (const id of trackedIds()) {
      for (const step of ['5m', '1h']) {
        const at = store.backfilledAt[step].get(id);
        if (!at || now - at > BACKFILL_MAX_AGE_MS) jobs.push([id, step]);
      }
    }
    const total = trackedIds().length * 2;
    state.backfill.total = total;
    state.backfill.done = total - jobs.length;
    const worker = async () => {
      while (jobs.length) {
        const [id, step] = jobs.shift();
        try { await store.backfill(id, step); } catch (e) { logError(`backfill ${id} ${step}`, e); }
        state.backfill.done++;
        await new Promise((r) => setTimeout(r, MOCK ? 0 : 250));
      }
    };
    await Promise.all([worker(), worker()]);
  } finally {
    backfilling = false;
  }
}

async function refresh() {
  const now = Date.now();
  try {
    if (now - state.mappingAt > MAPPING_MAX_AGE_MS) {
      await store.loadMapping();
      state.mappingAt = now;
    }
    await store.refreshLatest();
    await store.refreshBucket('5m');
    if (now - state.lastHourly > HOURLY_BUCKET_MS) {
      await store.refreshBucket('1h');
      state.lastHourly = now;
    }
    state.lastRefresh = Date.now();
    gradeJournal();
    historyFiles.flush();
  } catch (e) {
    logError('refresh', e);
  }
  state.nextRefresh = Date.now() + REFRESH_MS;
  resultsCache.clear();
  if (lastSettings) setImmediate(() => { try { computeResults(lastSettings); slotPlan(lastSettings); } catch (e) { logError('warm', e); } });
  backfillPending().then(() => {
    if (!backtests.sell.size) runBacktests();
  }).catch((e) => logError('backfill', e));
}

const resultsCache = new Map();
let lastSettings = null; // warm the cache for these right after each refresh
// The only choices: risk (low / mid / high), timeframe (how long each buy or
// sell offer may take) and your GP. Everything else is tuned for the best gp/h.
function parseSettings(q) {
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v != null ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const tf = num(q.get('timeframe'), 240, 5, 72 * 60); // minutes
  const risk = ['low', 'mid', 'high'].includes(q.get('risk')) ? q.get('risk') : 'mid';
  return {
    timeframeMin: tf,
    buyWithinHours: tf / 60,
    sellWithinHours: tf / 60,
    maxWaitHours: (2 * tf) / 60 + 0.25, // buy + sell + a bit for crafting
    capital: num(q.get('capital'), DEFAULTS.capital, 1000, 1e11),
    objective: 'profitPerHour',
    risk,
    riskAversion: RISK_LEVELS[risk],
    share: num(q.get('share'), DEFAULTS.share, 0.01, 1),
    maxActive: 15, // "least work": no craft needing more than 15 min of clicking per batch
    slots: 8,
    useAI: q.get('ai') !== '0',
    // learned from your real fills: how much longer offers take than predicted
    timeFactor: timingFactor(positions.list()).factor,
  };
}

function computeResults(settings) {
  lastSettings = settings;
  priceAI.setRecipes(loadRecipes().recipes);
  const key = JSON.stringify(settings) + ':' + store.version + ':' + recipesCache.mtime;
  if (resultsCache.has(key)) return resultsCache.get(key);
  const ai = { sellAdvisor: advisorFor(settings, 'sell'), buyAdvisor: advisorFor(settings, 'buy') };
  const results = loadRecipes().recipes.map((r) => {
    try {
      return evaluateRecipe(r, (n) => store.getItem(n), { ...settings, ...ai });
    } catch (e) {
      logError(`recipe ${r.id}`, e);
      return { id: r.id, name: r.output.item, category: r.category, status: 'error', missing: [e.message] };
    }
  });
  const out = { results };
  resultsCache.set(key, out);
  return out;
}

function aiStatus(settings) {
  const sellW = snapWindow(settings.sellWithinHours * 3600);
  const buyBts = [...backtests.buy.values()];
  // for buying, report the window it's used most for: the longest tested one within max wait
  const buyBt = buyBts.filter((b) => b.windowSec <= settings.maxWaitHours * 3600).sort((a, b) => b.windowSec - a.windowSec)[0] || buyBts[0] || null;
  return {
    on: settings.useAI,
    risk: settings.risk,
    sell: { windowSec: sellW, backtest: backtests.sell.get(sellW) || null, active: settings.useAI && aiAllowed('sell', sellW),
      journal: journal.stats('sell') },
    buy: { windowSec: buyBt ? buyBt.windowSec : null, backtest: buyBt, active: settings.useAI && (!buyBt || buyBt.uplift >= 0),
      journal: journal.stats('buy') },
  };
}

// GE slot plan: depends on your open trades too, so it's cached separately.
let positionsRev = 0;
const slotCache = new Map();
function slotPlan(settings) {
  const key = JSON.stringify(settings) + ':' + store.version + ':' + recipesCache.mtime + ':' + positionsRev;
  if (slotCache.has(key)) return slotCache.get(key);
  const { results } = computeResults(settings);
  // best single crafts to start, skipping anything that clashes with open trades
  const used = inUse(positions.list());
  const freeGp = Math.max(0, settings.capital - used.cash);
  const best = rankCrafts(results, settings.maxActive, used.items, freeGp).slice(0, 5).map((r) => r.id);
  const bestNote = best.length ? null : explainEmpty({ results, busyItems: used.items, maxActiveMinutes: settings.maxActive,
    freeCash: freeGp, freeSlots: Infinity, floor: worthwhileFloor(results, undefined, freeGp) });
  const opts = { ...settings, sellAdvisor: advisorFor(settings, 'sell'), buyAdvisor: advisorFor(settings, 'buy') };
  const plan = planSlots({
    results, positions: positions.list(), capital: settings.capital, slots: settings.slots,
    maxActiveMinutes: settings.maxActive,
    replan: (id, batch) => {
      const recipe = recipeById(id);
      return recipe ? evaluateRecipe({ ...recipe, batch }, (n) => store.getItem(n), opts) : null;
    },
  });
  const out = { plan, best, bestNote };
  slotCache.clear();
  slotCache.set(key, out);
  return out;
}

function recipeById(id) {
  return loadRecipes().recipes.find((r) => r.id === id) || null;
}

function positionsView(settings) {
  const getItem = (n) => store.getItem(n);
  return positions.list().map((p) => {
    if (!['buying', 'ready', 'selling'].includes(p.status) || !state.lastRefresh) return p;
    try {
      return { ...p, advice: advise(p, recipeById(p.recipeId), getItem, { ...settings, sellAdvisor: advisorFor(settings, 'sell'), buyAdvisor: advisorFor(settings, 'buy') }) };
    } catch (e) {
      logError(`advice ${p.id}`, e);
      return { ...p, advice: { kind: 'info', text: 'Could not compute advice: ' + e.message } };
    }
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 100_000) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); }
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handlePositions(req, res, url) {
  const settings = parseSettings(url.searchParams);
  const m = url.pathname.match(/^\/api\/positions(?:\/([\w-]+))?$/);
  if (!m || req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
  const body = await readJson(req);
  if (!m[1]) {
    const recipe = recipeById(body.recipeId);
    if (!recipe) return sendJson(res, 400, { error: 'Unknown craft' });
    const batch = Math.max(1, Math.min(1_000_000, Math.round(Number(body.batch)) || 0)) || undefined;
    // Plan with the same AI advisors the advice uses, so the two agree.
    const r = evaluateRecipe(batch ? { ...recipe, batch } : recipe, (n) => store.getItem(n),
      { ...settings, sellAdvisor: advisorFor(settings, 'sell'), buyAdvisor: advisorFor(settings, 'buy') });
    if (r.status !== 'ok') return sendJson(res, 400, { error: 'No price data for this craft yet' });
    const pos = positions.create({ recipe, batch: r.batch, plan: r.plan, prices: body.prices, bought: !!body.bought });
    positionsRev++;
    return sendJson(res, 200, pos);
  }
  positionsRev++;
  let predictedSec = null;
  if (body.action === 'reprice-buy' || body.action === 'list') {
    const cur = positions.get(m[1]);
    if (cur && state.lastRefresh) {
      try {
        const a = advise(cur, recipeById(cur.recipeId), (n) => store.getItem(n),
          { ...settings, sellAdvisor: advisorFor(settings, 'sell'), buyAdvisor: advisorFor(settings, 'buy') });
        const tf = settings.timeFactor || 1;
        const sug = body.action === 'list' ? a : (a.inputs || [])[body.index];
        if (sug && sug.price === Math.round(Number(body.price)) && Number.isFinite(sug.median)) predictedSec = sug.median / tf;
      } catch (e) { logError('predict', e); }
    }
  }
  const pos = positions.act(m[1], { ...body, predictedSec });
  return sendJson(res, 200, pos || { deleted: true });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/positions')) {
    handlePositions(req, res, url).catch((e) => {
      if (!e.status) logError('positions', e);
      sendJson(res, e.status || 500, { error: e.message });
    });
    return;
  }
  // The exact plan for one craft at a chosen batch size (used by the start dialog,
  // so its suggested prices match what the trade advice will say).
  if (url.pathname === '/api/plan') {
    const settings = parseSettings(url.searchParams);
    const recipe = recipeById(url.searchParams.get('recipeId'));
    if (!recipe || !state.lastRefresh) return sendJson(res, 404, { error: 'Unknown craft' });
    const batch = Math.max(1, Math.min(1_000_000, Math.round(Number(url.searchParams.get('batch'))) || 0)) || undefined;
    const r = evaluateRecipe(batch ? { ...recipe, batch } : recipe, (n) => store.getItem(n),
      { ...settings, sellAdvisor: advisorFor(settings, 'sell'), buyAdvisor: advisorFor(settings, 'buy') });
    return sendJson(res, 200, r.status === 'ok' ? { batch: r.batch, plan: r.plan, gph: r.plan.riskAdjusted / Math.max(r.plan.hours, 1 / 60) } : { error: 'No price data yet' });
  }
  if (url.pathname === '/api/state') {
    const settings = parseSettings(url.searchParams);
    const body = {
      mock: MOCK,
      now: Date.now(),
      lastRefresh: state.lastRefresh,
      nextRefresh: state.nextRefresh,
      backfill: state.backfill,
      errors: state.errors.slice(0, 5),
      settings,
      ...(state.lastRefresh ? computeResults(settings) : { results: [] }),
      ...(state.lastRefresh ? (({ plan, best, bestNote }) => ({ slotPlan: plan, best, bestNote }))(slotPlan(settings)) : { slotPlan: null, best: [] }),
      positions: positionsView(settings),
      ai: aiStatus(settings),
      stats: stats(positions.list()),
      timing: timingFactor(positions.list()),
      memory: store.memoryStats(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

let polling = false;
async function tickPoll() {
  if (polling || !state.lastRefresh) return;
  polling = true;
  try {
    await store.pollTicks();
  } catch (e) {
    logError('tick poll', e);
  } finally {
    polling = false;
  }
}

server.listen(PORT, HOST, () => {
  console.log(`OSRS craft tracker on http://localhost:${PORT}${MOCK ? ' (MOCK DATA)' : ''}`);
  refresh();
  setInterval(refresh, REFRESH_MS);
  if (TICK_MS > 0) setInterval(tickPoll, TICK_MS);
  setInterval(() => { try { historyFiles.compact(store); } catch (e) { logError('compact', e); } }, COMPACT_MS);
});

// Exit cleanly on Ctrl+C / kill so any pending output is flushed.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { historyFiles.flush(); } catch (e) { /* exiting anyway */ }
    process.exit(0);
  });
}
