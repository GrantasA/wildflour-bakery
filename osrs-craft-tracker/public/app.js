'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  rows: $('rows'), status: $('status'), mock: $('mock'),
  objective: $('objective'), maxWait: $('maxWait'), capital: $('capital'), share: $('share'),
  maxActive: $('maxActive'), hidden: $('hidden'),
  search: $('search'), category: $('category'), viableOnly: $('viableOnly'),
};

let data = null;
let sortKey = 'profitPerHour';
let sortAsc = false;
const expanded = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function gp(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 1 : 2) + 'M';
  if (a >= 1e4) return s + (a / 1e3).toFixed(1) + 'K';
  return s + Math.round(a).toLocaleString();
}
const gpExact = (n) => (n == null ? '–' : Math.round(n).toLocaleString());
function dur(sec) {
  if (!Number.isFinite(sec)) return '∞';
  const m = Math.round(sec / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '–');
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

function parseGp(s) {
  const m = String(s).trim().toLowerCase().replace(/,/g, '').match(/^([\d.]+)\s*([kmb]?)$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
}

function query() {
  const p = new URLSearchParams({
    objective: els.objective.value,
    maxWait: els.maxWait.value,
    share: els.share.value,
  });
  const cap = parseGp(els.capital.value);
  if (cap) p.set('capital', cap);
  return p.toString();
}

function saveSettings() {
  try {
    localStorage.setItem('osrs-craft-settings', JSON.stringify({
      objective: els.objective.value, maxWait: els.maxWait.value, capital: els.capital.value, share: els.share.value,
      maxActive: els.maxActive.value, sortKey, sortAsc,
    }));
  } catch (e) { /* storage unavailable */ }
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('osrs-craft-settings') || 'null');
    if (!s) return;
    for (const k of ['objective', 'maxWait', 'capital', 'share', 'maxActive']) if (s[k] != null) els[k].value = s[k];
    if (s.sortKey) { sortKey = s.sortKey; sortAsc = !!s.sortAsc; }
  } catch (e) { /* storage unavailable */ }
}

let inflight = null;
async function load() {
  const q = query();
  inflight = q;
  try {
    const res = await fetch('/api/state?' + q);
    const body = await res.json();
    if (inflight !== q) return;
    data = body;
    render();
  } catch (e) {
    els.status.textContent = 'Cannot reach tracker server: ' + e.message;
  }
}

function sortValue(r) {
  if (r.status !== 'ok') return -Infinity;
  const p = r.plan;
  switch (sortKey) {
    case 'name': return r.name.toLowerCase();
    case 'batch': return r.batch;
    case 'cost': return p.cost;
    case 'sell': return p.sell.price;
    case 'tax': return p.taxTotal;
    case 'instant': return r.instant.profit;
    default: return p[sortKey];
  }
}

function renderStatus() {
  if (!data) return;
  els.mock.hidden = !data.mock;
  const parts = [];
  if (data.lastRefresh) parts.push(`Prices updated ${Math.round((Date.now() - data.lastRefresh) / 1000)}s ago`);
  else parts.push('Fetching prices…');
  if (data.nextRefresh) parts.push(`next in ${Math.max(0, Math.round((data.nextRefresh - Date.now()) / 1000))}s`);
  const b = data.backfill;
  if (b.total && b.done < b.total) parts.push(`loading trade history ${b.done}/${b.total}`);
  if (data.errors.length) parts.push(`⚠ ${data.errors[0]}`);
  els.status.textContent = parts.join(' · ');
}

function render() {
  renderStatus();
  const cats = [...new Set(data.results.map((r) => r.category))].sort();
  if (els.category.options.length - 1 !== cats.length) {
    const cur = els.category.value;
    els.category.innerHTML = '<option value="">All</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
    els.category.value = cur;
  }

  // Crafts with an ingredient or product that isn't on the GE can't be done by
  // buying and selling, so leave them out of the table entirely.
  const untradeable = data.results.filter((r) => r.status === 'missing');
  els.hidden.textContent = untradeable.length
    ? `Hidden: ${untradeable.length} craft(s) with items not tradeable on the GE (${untradeable.map((r) => `${r.name}: ${r.missing.join(', ')}`).join('; ')})`
    : '';
  const maxActive = parseFloat(els.maxActive.value);
  const term = els.search.value.trim().toLowerCase();
  let rows = data.results.filter((r) => {
    if (r.status === 'missing') return false;
    if (Number.isFinite(maxActive) && (r.status !== 'ok' || r.plan.activeSeconds > maxActive * 60)) return false;
    if (els.category.value && r.category !== els.category.value) return false;
    if (els.viableOnly.checked && !r.viable) return false;
    if (term && !(r.name.toLowerCase().includes(term) || (r.ingredients || []).some((i) => i.item.toLowerCase().includes(term)))) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (!!a.viable !== !!b.viable) return a.viable ? -1 : 1; // viable crafts first
    const va = sortValue(a), vb = sortValue(b);
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return sortAsc ? c : -c;
  });

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.classList.toggle('asc', th.dataset.sort === sortKey && sortAsc);
  });

  if (!data.lastRefresh) {
    els.rows.innerHTML = '<tr><td colspan="13" class="muted">Waiting for first price pull…</td></tr>';
    return;
  }
  els.rows.innerHTML = rows.map(rowHtml).join('') ||
    '<tr><td colspan="13" class="muted">No crafts match.</td></tr>';
}

const hi = (objective, html) => (els.objective.value === objective ? `<b>${html}</b>` : html);

function rowHtml(r) {
  const open = expanded.has(r.id);
  const title = `<span class="viable ${r.viable ? 'yes' : ''}"></span>${esc(r.name)}${r.outputQty > 1 ? ` ×${r.outputQty}` : ''}<span class="cat">${esc(r.category)}</span>`;
  if (r.status !== 'ok') {
    const why = r.status === 'missing' ? 'unknown item(s): ' : r.status === 'nodata' ? 'no price data yet: ' : 'error: ';
    return `<tr class="row dim" data-id="${esc(r.id)}"><td>${title}</td><td colspan="12" class="muted">${esc(why + (r.missing || []).join(', '))}</td></tr>`;
  }
  const p = r.plan;
  const flags = r.flags.length ? `<div class="flags">${r.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join('')}</div>` : '';
  return `<tr class="row ${r.viable ? '' : 'dim'}" data-id="${esc(r.id)}">
    <td>${title}${flags}</td>
    <td class="num">${r.batch}</td>
    <td class="num">${gp(p.cost)}</td>
    <td class="num">${gp(p.sell.price)}</td>
    <td class="num">${gp(p.taxTotal)}</td>
    <td class="num ${cls(p.profit)}">${hi('profit', gp(p.profit))}</td>
    <td class="num ${cls(p.profitPerCraft)}">${gp(p.profitPerCraft)}</td>
    <td class="num">${dur(p.seconds)}</td>
    <td class="num ${cls(p.profitPerHour)}">${hi('profitPerHour', gp(p.profitPerHour))}</td>
    <td class="num">${dur(p.activeSeconds)}</td>
    <td class="num ${cls(p.profitPerActiveHour)}">${hi('activeProfit', gp(p.profitPerActiveHour))}</td>
    <td class="num ${cls(p.roi)}">${pct(p.roi)}</td>
    <td class="num ${cls(r.instant.profit)}">${gp(r.instant.profit)}</td>
  </tr>${open ? detailHtml(r) : ''}`;
}

function ladderHtml(title, curve, side, chosen, qty) {
  let pts = curve.points.slice(0, 14);
  if (!pts.some((pt) => pt.price === chosen)) {
    const pick = curve.points.find((pt) => pt.price === chosen);
    if (pick) pts = [...pts.slice(0, 13), pick];
  }
  return `<div class="scroll"><h3>${esc(title)} <span class="muted">(${side === 'buy' ? 'buy' : 'sell'} ${qty.toLocaleString()}, ${esc(curve.series)} history)</span></h3>
    <table class="ladder"><thead><tr><th class="num">Offer price</th><th class="num">Median fill</th><th class="num">Slow case (p90)</th></tr></thead><tbody>
    ${pts.map((pt) => `<tr><td class="num ${pt.price === chosen ? 'best' : ''}">${gpExact(pt.price)}</td><td class="num">${dur(pt.median)}</td><td class="num">${dur(pt.p90)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function detailHtml(r) {
  const p = r.plan, i = r.instant;
  const inputRows = p.inputs.map((x) => `<tr>
      <td>${esc(x.name)}</td><td class="num">${x.qty.toLocaleString()}</td>
      <td class="num"><b>${gpExact(x.price)}</b></td><td class="num">${gpExact(x.instaSell)}</td><td class="num">${gpExact(x.instaBuy)}</td>
      <td class="num">${dur(x.median)}</td><td class="num">${dur(x.p90)}</td></tr>`).join('');
  const s = p.sell;
  return `<tr class="detail"><td colspan="13"><div class="detail"><div class="scroll">
    <p class="muted">${esc(r.skills || '')}${r.notes ? ' · ' + esc(r.notes) : ''}${r.coins ? ` · ${gpExact(r.coins)} gp fee per craft` : ''}</p>
    <h3>Recommended offers (batch of ${r.batch})</h3>
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Offer at</th><th class="num">Insta-sell now</th><th class="num">Insta-buy now</th><th class="num">Median fill</th><th class="num">p90 fill</th></tr></thead>
    <tbody>${inputRows}
      <tr><td><b>SELL</b> ${esc(s.name)}</td><td class="num">${s.qty.toLocaleString()}</td><td class="num"><b>${gpExact(s.price)}</b></td>
        <td class="num">${gpExact(s.instaSell)}</td><td class="num">${gpExact(s.instaBuy)}</td><td class="num">${dur(s.median)}</td><td class="num">${dur(s.p90)}</td></tr>
    </tbody></table></div>
    <p>Cost ${gpExact(p.cost)} · revenue ${gpExact(p.revenue)} · tax ${gpExact(p.taxTotal)} (${gpExact(s.tax)} each) ·
      <b class="${cls(p.profit)}">profit ${gpExact(p.profit)}</b> over ~${dur(p.seconds)} (buy ${dur(p.buySeconds)}, craft ${dur(p.craftSeconds)}, sell ${dur(s.median)}) · your hands-on time ~${dur(p.activeSeconds)}</p>
    <p class="muted">Instant alternative (buy at ask, sell into bid): profit ${gpExact(i.profit)} over ~${dur(i.seconds)} → ${gp(i.profitPerHour)}/h</p>
    <div class="detail-grid">
      ${ladderHtml('Sell ' + r.curves.output.name, r.curves.output, 'sell', s.price, s.qty)}
      ${r.curves.inputs.map((c, k) => ladderHtml(c.name, c, 'buy', p.inputs[k].price, p.inputs[k].qty)).join('')}
    </div>
  </div></td></tr>`;
}

els.rows.addEventListener('click', (e) => {
  const tr = e.target.closest('tr.row');
  if (!tr) return;
  const id = tr.dataset.id;
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  render();
});
document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  if (sortKey === th.dataset.sort) sortAsc = !sortAsc;
  else { sortKey = th.dataset.sort; sortAsc = ['name', 'hours', 'activeSeconds'].includes(sortKey); }
  saveSettings();
  render();
}));
let debounce;
const OBJECTIVE_SORT = { profitPerHour: 'profitPerHour', activeProfit: 'profitPerActiveHour', profit: 'profit' };
els.objective.addEventListener('change', () => { sortKey = OBJECTIVE_SORT[els.objective.value]; sortAsc = false; });
els.maxActive.addEventListener('input', () => { saveSettings(); if (data) render(); });
for (const k of ['objective', 'maxWait', 'capital', 'share']) {
  els[k].addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { saveSettings(); load(); }, 300); });
}
for (const k of ['search', 'category', 'viableOnly']) els[k].addEventListener('input', () => data && render());

loadSettings();
load();
setInterval(load, 15_000);
setInterval(renderStatus, 1000);
