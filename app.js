'use strict';

/* ---------- Config ---------- */

const CATEGORIES = [
  { id: 'food',      name: 'Food & Drink', emoji: '🍽️', color: '#f59e0b' },
  { id: 'taxi',      name: 'Taxi / Ride',  emoji: '🚕', color: '#eab308' },
  { id: 'transport', name: 'Train / Bus',  emoji: '🚆', color: '#10b981' },
  { id: 'flight',    name: 'Flights',      emoji: '✈️', color: '#3b82f6' },
  { id: 'hotel',     name: 'Hotel',        emoji: '🏨', color: '#8b5cf6' },
  { id: 'car',       name: 'Car / Fuel',   emoji: '⛽', color: '#ef4444' },
  { id: 'parking',   name: 'Parking/Tolls',emoji: '🅿️', color: '#64748b' },
  { id: 'other',     name: 'Other',        emoji: '🧾', color: '#ec4899' },
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'MXN', 'JPY', 'CHF', 'CNY', 'INR', 'BRL', 'SGD', 'HKD', 'NZD', 'SEK', 'NOK', 'DKK', 'ZAR', 'AED'];

/* ---------- Tiny IndexedDB wrapper ---------- */

const DB_NAME = 'trip-receipts';
let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('trips', { keyPath: 'id' });
        const r = d.createObjectStore('receipts', { keyPath: 'id' });
        r.createIndex('tripId', 'tripId');
        d.createObjectStore('photos', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function promisify(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}
async function store(name, mode = 'readonly') {
  return (await db()).transaction(name, mode).objectStore(name);
}
const getAll = async (name) => promisify((await store(name)).getAll());
const get = async (name, id) => promisify((await store(name)).get(id));
const put = async (name, val) => promisify((await store(name, 'readwrite')).put(val));
const del = async (name, id) => promisify((await store(name, 'readwrite')).delete(id));
const receiptsFor = async (tripId) =>
  promisify((await store('receipts')).index('tripId').getAll(tripId));

/* ---------- Helpers ---------- */

const $ = (sel, el = document) => el.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(n, cur) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n || 0);
  } catch {
    return `${(n || 0).toFixed(2)} ${cur}`;
  }
}
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
// Amount expressed in the trip's home currency.
const homeAmount = (r) => (r.homeAmount != null ? r.homeAmount : r.amount) || 0;

function currencyOptions(selected) {
  const list = CURRENCIES.includes(selected) ? CURRENCIES : [selected, ...CURRENCIES];
  return list.map(c => `<option ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}

// Shrink photos so storage doesn't explode (phone photos are often 4-8 MB).
async function compressImage(file, maxDim = 1600, quality = 0.8) {
  if (!file.type.startsWith('image/')) return file; // e.g. PDF receipts: store as-is
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(b => res(b || file), 'image/jpeg', quality));
}

const blobToDataURL = (blob) => new Promise((res, rej) => {
  const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
});
const dataURLToBlob = async (url) => (await fetch(url)).blob();

function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Object URLs for thumbnails; revoked on each re-render.
let liveUrls = [];
function photoUrl(blob) {
  const u = URL.createObjectURL(blob);
  liveUrls.push(u);
  return u;
}
function releaseUrls() { liveUrls.forEach(URL.revokeObjectURL); liveUrls = []; }

/* ---------- Routing ---------- */

const view = $('#view');
const titleEl = $('#title');
const backBtn = $('#backBtn');
const fab = $('#fab');
const dialog = $('#dialog');
let state = { tripId: null, filter: 'all' };

function route() {
  const m = location.hash.match(/^#\/trip\/(.+)$/);
  state.tripId = m ? decodeURIComponent(m[1]) : null;
  render();
}
window.addEventListener('hashchange', () => { state.filter = 'all'; route(); });
backBtn.onclick = () => { location.hash = '#/'; };

async function render() {
  releaseUrls();
  if (state.tripId) return renderTrip(state.tripId);
  return renderTrips();
}

/* ---------- Trips list ---------- */

async function renderTrips() {
  titleEl.textContent = 'My Trips';
  backBtn.hidden = true;
  fab.setAttribute('aria-label', 'New trip');
  fab.onclick = () => tripDialog();

  const [trips, receipts] = await Promise.all([getAll('trips'), getAll('receipts')]);
  trips.sort((a, b) => (b.start || '').localeCompare(a.start || '') || b.createdAt - a.createdAt);

  if (!trips.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="big">🧳</div>
        <p><strong>No trips yet.</strong></p>
        <p>Tap <strong>+</strong> to create your first work trip, then snap photos of your receipts as you go.</p>
      </div>`;
    return;
  }

  view.innerHTML = trips.map(t => {
    const rs = receipts.filter(r => r.tripId === t.id);
    const total = rs.reduce((s, r) => s + homeAmount(r), 0);
    const dates = [fmtDate(t.start), fmtDate(t.end)].filter(Boolean).join(' – ');
    return `
      <div class="card list-item" data-trip="${esc(t.id)}">
        <div class="cat-icon" style="background:color-mix(in srgb, var(--accent) 15%, transparent)">🧳</div>
        <div class="grow">
          <div class="name">${esc(t.name)}</div>
          <div class="muted">${esc([t.destination, dates].filter(Boolean).join(' · '))}</div>
          <div class="muted">${rs.length} receipt${rs.length === 1 ? '' : 's'}</div>
        </div>
        <div class="amount">${money(total, t.currency)}</div>
      </div>`;
  }).join('');

  view.querySelectorAll('[data-trip]').forEach(el =>
    el.onclick = () => { location.hash = '#/trip/' + encodeURIComponent(el.dataset.trip); });
}

function tripDialog(trip) {
  const t = trip || { id: uid(), name: '', destination: '', start: today(), end: '', currency: 'USD', createdAt: Date.now() };
  dialog.innerHTML = `
    <form method="dialog">
      <h2>${trip ? 'Edit trip' : 'New trip'}</h2>
      <label>Trip name</label>
      <input name="name" required placeholder="e.g. Chicago client visit" value="${esc(t.name)}">
      <label>Destination</label>
      <input name="destination" placeholder="City / client" value="${esc(t.destination)}">
      <div class="row">
        <div><label>Start date</label><input type="date" name="start" value="${esc(t.start)}"></div>
        <div><label>End date</label><input type="date" name="end" value="${esc(t.end)}"></div>
      </div>
      <div class="row">
        <div><label>Reporting currency</label><select name="currency">${currencyOptions(t.currency)}</select></div>
        <div><label>Budget (optional)</label><input type="number" inputmode="decimal" step="0.01" min="0" name="budget" value="${t.budget ?? ''}"></div>
      </div>
      <div class="dialog-actions">
        ${trip ? '<button type="button" class="btn danger" data-del>Delete</button><span class="spacer"></span>' : ''}
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`;
  const form = $('form', dialog);
  $('[data-cancel]', dialog).onclick = () => dialog.close();
  const delBtn = $('[data-del]', dialog);
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(`Delete "${t.name}" and all its receipts? This cannot be undone.`)) return;
    for (const r of await receiptsFor(t.id)) {
      if (r.photoId) await del('photos', r.photoId);
      await del('receipts', r.id);
    }
    await del('trips', t.id);
    dialog.close();
    location.hash = '#/';
    render();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const budget = parseFloat(f.get('budget'));
    await put('trips', {
      ...t,
      name: f.get('name').trim(),
      destination: f.get('destination').trim(),
      start: f.get('start'),
      end: f.get('end'),
      currency: f.get('currency'),
      budget: isNaN(budget) ? null : budget,
    });
    dialog.close();
    if (!trip) location.hash = '#/trip/' + encodeURIComponent(t.id);
    else render();
  };
  dialog.showModal();
}

/* ---------- Trip detail ---------- */

async function renderTrip(id) {
  const trip = await get('trips', id);
  if (!trip) { location.hash = '#/'; return; }
  titleEl.textContent = trip.name;
  backBtn.hidden = false;
  fab.setAttribute('aria-label', 'Add receipt');
  fab.onclick = () => receiptDialog(trip);

  const receipts = await receiptsFor(id);
  receipts.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  const total = receipts.reduce((s, r) => s + homeAmount(r), 0);
  const byCat = {};
  for (const r of receipts) byCat[r.category] = (byCat[r.category] || 0) + homeAmount(r);
  const usedCats = CATEGORIES.filter(c => byCat[c.id]);
  const owed = receipts.filter(r => r.payment === 'personal' && !r.reimbursed)
    .reduce((s, r) => s + homeAmount(r), 0);
  const missingPhotos = receipts.filter(r => !r.photoId).length;

  const shown = state.filter === 'all' ? receipts : receipts.filter(r => r.category === state.filter);

  let budgetLine = '';
  if (trip.budget) {
    const left = trip.budget - total;
    budgetLine = `<div class="muted" style="margin-bottom:8px">Budget ${money(trip.budget, trip.currency)} ·
      <strong style="color:${left < 0 ? 'var(--danger)' : 'inherit'}">${left < 0 ? 'over by ' + money(-left, trip.currency) : money(left, trip.currency) + ' left'}</strong></div>`;
  }

  view.innerHTML = `
    <div class="card summary">
      <div class="muted">${esc([trip.destination, [fmtDate(trip.start), fmtDate(trip.end)].filter(Boolean).join(' – ')].filter(Boolean).join(' · '))}</div>
      <div class="total">${money(total, trip.currency)}</div>
      ${budgetLine}
      ${usedCats.length ? `
        <div class="bar">${usedCats.map(c => `<span style="width:${(byCat[c.id] / total) * 100}%;background:${c.color}"></span>`).join('')}</div>
        <div class="legend">${usedCats.map(c => `<div><i style="background:${c.color}"></i>${c.emoji} ${c.name}<b>${money(byCat[c.id], trip.currency)}</b></div>`).join('')}</div>
      ` : ''}
      ${owed > 0 ? `<p style="margin:12px 0 0">💳 Paid personally, awaiting reimbursement: <strong>${money(owed, trip.currency)}</strong></p>` : ''}
      ${missingPhotos ? `<p class="muted" style="margin:6px 0 0">⚠️ ${missingPhotos} receipt${missingPhotos === 1 ? '' : 's'} without a photo</p>` : ''}
    </div>

    <div class="actions">
      <button class="btn" data-act="edit">✏️ Edit trip</button>
      <button class="btn" data-act="csv" ${receipts.length ? '' : 'disabled'}>⬇️ Export CSV</button>
      <button class="btn" data-act="report" ${receipts.length ? '' : 'disabled'}>🖨️ Report / PDF</button>
      <button class="btn" data-act="photos" ${receipts.length - missingPhotos ? '' : 'disabled'}>🖼️ Save photos</button>
    </div>

    ${receipts.length ? `
      <div class="chips">
        <button class="chip ${state.filter === 'all' ? 'on' : ''}" data-filter="all">All (${receipts.length})</button>
        ${usedCats.map(c => `<button class="chip ${state.filter === c.id ? 'on' : ''}" data-filter="${c.id}">${c.emoji} ${c.name}</button>`).join('')}
      </div>` : ''}

    <div id="receiptList">
      ${receipts.length ? '' : `
        <div class="empty">
          <div class="big">🧾</div>
          <p>No receipts yet. Tap <strong>+</strong> to add one — you can take a photo right away.</p>
        </div>`}
    </div>`;

  const list = $('#receiptList');
  for (const r of shown) {
    const c = CAT[r.category] || CAT.other;
    const el = document.createElement('div');
    el.className = 'card list-item';
    let icon = `<div class="cat-icon" style="background:color-mix(in srgb, ${c.color} 20%, transparent)">${c.emoji}</div>`;
    if (r.photoId) {
      const p = await get('photos', r.photoId);
      if (p && p.blob.type.startsWith('image/')) icon = `<img class="thumb" alt="" src="${photoUrl(p.blob)}">`;
    }
    const foreign = r.currency !== trip.currency;
    el.innerHTML = `
      ${icon}
      <div class="grow">
        <div class="name">${esc(r.merchant || c.name)}</div>
        <div class="muted">${fmtDate(r.date)} · ${c.name}
          ${r.payment === 'personal' ? `<span class="badge ${r.reimbursed ? '' : 'warn'}">${r.reimbursed ? 'reimbursed' : 'personal'}</span>` : ''}
          ${r.photoId ? '' : '<span class="badge">no photo</span>'}
        </div>
      </div>
      <div style="text-align:right">
        <div class="amount">${money(homeAmount(r), trip.currency)}</div>
        ${foreign ? `<div class="muted">${money(r.amount, r.currency)}</div>` : ''}
      </div>`;
    el.onclick = () => receiptDialog(trip, r);
    list.appendChild(el);
  }

  view.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { state.filter = b.dataset.filter; render(); });
  $('[data-act=edit]').onclick = () => tripDialog(trip);
  $('[data-act=csv]').onclick = () => exportCSV(trip, receipts);
  $('[data-act=report]').onclick = () => printReport(trip, receipts);
  $('[data-act=photos]').onclick = () => savePhotos(trip, receipts);
}

/* ---------- Receipt form ---------- */

function receiptDialog(trip, receipt) {
  const r = receipt || {
    id: uid(), tripId: trip.id, date: today(), merchant: '', category: 'food',
    amount: null, currency: trip.currency, homeAmount: null, payment: 'company',
    reimbursed: false, notes: '', photoId: null, createdAt: Date.now(),
  };
  // Keep the date inside the trip if "today" falls outside it.
  if (!receipt && trip.start && r.date < trip.start) r.date = trip.start;

  let newPhoto = null;      // Blob chosen in this dialog
  let removePhoto = false;

  dialog.innerHTML = `
    <form method="dialog">
      <h2>${receipt ? 'Edit receipt' : 'Add receipt'}</h2>

      <div class="photo-box" id="photoBox">
        <div id="photoPreview"></div>
        <div id="photoLabel">📷 Take photo or choose file</div>
        <input type="file" id="photoInput" accept="image/*,application/pdf" capture="environment" hidden>
      </div>
      <div style="text-align:center;margin-top:6px">
        <button type="button" class="btn" id="pickFile" style="font-size:.85rem;padding:6px 10px">Choose from gallery / files</button>
        <button type="button" class="btn danger" id="removePhoto" style="font-size:.85rem;padding:6px 10px" hidden>Remove photo</button>
      </div>

      <label>Category</label>
      <div class="cat-picker">
        ${CATEGORIES.map(c => `
          <label><input type="radio" name="category" value="${c.id}" ${r.category === c.id ? 'checked' : ''}>
          <span class="e">${c.emoji}</span>${c.name}</label>`).join('')}
      </div>

      <div class="row">
        <div><label>Amount</label><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" required value="${r.amount ?? ''}" placeholder="0.00"></div>
        <div class="narrow"><label>Currency</label><select name="currency">${currencyOptions(r.currency)}</select></div>
      </div>
      <div id="homeRow" ${r.currency === trip.currency ? 'hidden' : ''}>
        <label>Amount in ${esc(trip.currency)} (from your card statement or an exchange rate)</label>
        <input name="homeAmount" type="number" inputmode="decimal" step="0.01" min="0" value="${r.currency !== trip.currency && r.homeAmount != null ? r.homeAmount : ''}">
      </div>

      <div class="row">
        <div><label>Date</label><input name="date" type="date" required value="${esc(r.date)}"></div>
        <div><label>Paid with</label>
          <select name="payment">
            <option value="company" ${r.payment === 'company' ? 'selected' : ''}>Company card</option>
            <option value="personal" ${r.payment === 'personal' ? 'selected' : ''}>Personal (reimburse me)</option>
          </select>
        </div>
      </div>

      <label>Merchant / vendor</label>
      <input name="merchant" placeholder="e.g. Uber, Joe's Diner" value="${esc(r.merchant)}" list="merchants">
      <datalist id="merchants"></datalist>

      <label>Notes (who / why)</label>
      <textarea name="notes" placeholder="e.g. Dinner with client team (4 people)">${esc(r.notes)}</textarea>

      <label class="check" id="reimbRow" ${r.payment === 'personal' ? '' : 'hidden'}>
        <input type="checkbox" name="reimbursed" ${r.reimbursed ? 'checked' : ''}> Already reimbursed
      </label>

      <div class="dialog-actions">
        ${receipt ? '<button type="button" class="btn danger" data-del>Delete</button><span class="spacer"></span>' : ''}
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`;

  const form = $('form', dialog);
  const photoInput = $('#photoInput');
  const preview = $('#photoPreview');
  const photoLabel = $('#photoLabel');
  const removeBtn = $('#removePhoto');

  function showPhoto(blob) {
    if (!blob) {
      preview.innerHTML = '';
      photoLabel.textContent = '📷 Take photo or choose file';
      removeBtn.hidden = true;
      return;
    }
    preview.innerHTML = blob.type.startsWith('image/')
      ? `<img alt="Receipt" src="${photoUrl(blob)}">`
      : `<div style="font-size:2.5rem">📄</div>`;
    photoLabel.textContent = 'Tap to retake';
    removeBtn.hidden = false;
  }
  if (r.photoId) get('photos', r.photoId).then(p => p && showPhoto(p.blob));

  $('#photoBox').onclick = () => { photoInput.setAttribute('capture', 'environment'); photoInput.click(); };
  $('#pickFile').onclick = () => { photoInput.removeAttribute('capture'); photoInput.click(); };
  photoInput.onchange = async () => {
    const file = photoInput.files[0];
    if (!file) return;
    photoLabel.textContent = 'Processing…';
    newPhoto = await compressImage(file);
    removePhoto = false;
    showPhoto(newPhoto);
  };
  removeBtn.onclick = () => { newPhoto = null; removePhoto = true; showPhoto(null); };

  form.currency.onchange = () => { $('#homeRow').hidden = form.currency.value === trip.currency; };
  form.payment.onchange = () => { $('#reimbRow').hidden = form.payment.value !== 'personal'; };

  // Suggest merchants used before.
  getAll('receipts').then(all => {
    const names = [...new Set(all.map(x => x.merchant).filter(Boolean))].sort();
    $('#merchants').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
  });

  $('[data-cancel]', dialog).onclick = () => dialog.close();
  const delBtn = $('[data-del]', dialog);
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm('Delete this receipt?')) return;
    if (r.photoId) await del('photos', r.photoId);
    await del('receipts', r.id);
    dialog.close();
    render();
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const currency = f.get('currency');
    const amount = parseFloat(f.get('amount')) || 0;
    let home = amount;
    if (currency !== trip.currency) {
      const h = parseFloat(f.get('homeAmount'));
      home = isNaN(h) ? null : h;
      if (home == null && !confirm(`No ${trip.currency} amount entered — the total will count it as ${amount} ${trip.currency}. Save anyway?`)) return;
    }

    let photoId = r.photoId;
    if ((newPhoto || removePhoto) && photoId) { await del('photos', photoId); photoId = null; }
    if (newPhoto) { photoId = uid(); await put('photos', { id: photoId, blob: newPhoto }); }

    await put('receipts', {
      ...r,
      category: f.get('category') || 'other',
      amount, currency,
      homeAmount: home,
      date: f.get('date'),
      payment: f.get('payment'),
      reimbursed: f.get('payment') === 'personal' && !!f.get('reimbursed'),
      merchant: f.get('merchant').trim(),
      notes: f.get('notes').trim(),
      photoId,
    });
    dialog.close();
    render();
  };

  dialog.showModal();
}

/* ---------- Export ---------- */

const safeName = (s) => s.replace(/[^\w\-]+/g, '_').replace(/^_|_$/g, '') || 'trip';

function exportCSV(trip, receipts) {
  const rows = [['Date', 'Merchant', 'Category', 'Amount', 'Currency', `Amount (${trip.currency})`, 'Paid with', 'Reimbursed', 'Notes', 'Has photo']];
  for (const r of [...receipts].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([
      r.date, r.merchant, (CAT[r.category] || CAT.other).name,
      (r.amount || 0).toFixed(2), r.currency, homeAmount(r).toFixed(2),
      r.payment === 'personal' ? 'Personal' : 'Company card',
      r.payment === 'personal' ? (r.reimbursed ? 'Yes' : 'No') : '',
      r.notes, r.photoId ? 'Yes' : 'No',
    ]);
  }
  rows.push([]);
  rows.push(['', '', 'TOTAL', '', '', receipts.reduce((s, r) => s + homeAmount(r), 0).toFixed(2)]);
  const csv = rows.map(row => row.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  download(`${safeName(trip.name)}_expenses.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

async function savePhotos(trip, receipts) {
  const files = [];
  for (const r of [...receipts].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!r.photoId) continue;
    const p = await get('photos', r.photoId);
    if (!p) continue;
    const ext = p.blob.type === 'application/pdf' ? 'pdf' : 'jpg';
    const name = `${r.date}_${safeName(r.merchant || CAT[r.category]?.name || 'receipt')}_${(r.amount || 0).toFixed(2)}${r.currency}.${ext}`;
    files.push(new File([p.blob], name, { type: p.blob.type }));
  }
  // On phones, the share sheet lets you send them all to email/Drive/Files at once.
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: `${trip.name} receipts` }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  for (const f of files) { download(f.name, f, f.type); await new Promise(r => setTimeout(r, 300)); }
}

async function printReport(trip, receipts) {
  const sorted = [...receipts].sort((a, b) => a.date.localeCompare(b.date));
  const total = sorted.reduce((s, r) => s + homeAmount(r), 0);
  const byCat = {};
  for (const r of sorted) byCat[r.category] = (byCat[r.category] || 0) + homeAmount(r);
  const owed = sorted.filter(r => r.payment === 'personal' && !r.reimbursed).reduce((s, r) => s + homeAmount(r), 0);

  let report = $('#report');
  if (!report) { report = document.createElement('div'); report.id = 'report'; document.body.appendChild(report); }

  const imgs = [];
  for (const [i, r] of sorted.entries()) {
    if (!r.photoId) continue;
    const p = await get('photos', r.photoId);
    if (p && p.blob.type.startsWith('image/')) imgs.push({ n: i + 1, r, url: photoUrl(p.blob) });
  }

  report.innerHTML = `
    <h1>Expense report: ${esc(trip.name)}</h1>
    <p>${esc([trip.destination, [fmtDate(trip.start), fmtDate(trip.end)].filter(Boolean).join(' – ')].filter(Boolean).join(' · '))}</p>
    <table>
      <thead><tr><th>#</th><th>Date</th><th>Merchant</th><th>Category</th><th>Paid with</th><th>Notes</th><th class="num">Original</th><th class="num">${esc(trip.currency)}</th></tr></thead>
      <tbody>
        ${sorted.map((r, i) => `<tr>
          <td>${i + 1}</td><td>${r.date}</td><td>${esc(r.merchant)}</td><td>${(CAT[r.category] || CAT.other).name}</td>
          <td>${r.payment === 'personal' ? 'Personal' : 'Company'}</td><td>${esc(r.notes)}</td>
          <td class="num">${r.currency !== trip.currency ? money(r.amount, r.currency) : ''}</td>
          <td class="num">${money(homeAmount(r), trip.currency)}</td></tr>`).join('')}
      </tbody>
      <tfoot><tr><th colspan="7">Total</th><th class="num">${money(total, trip.currency)}</th></tr></tfoot>
    </table>
    <table style="width:auto">
      ${CATEGORIES.filter(c => byCat[c.id]).map(c => `<tr><td>${c.name}</td><td class="num">${money(byCat[c.id], trip.currency)}</td></tr>`).join('')}
      ${owed ? `<tr><th>Owed to employee (personal, not yet reimbursed)</th><th class="num">${money(owed, trip.currency)}</th></tr>` : ''}
    </table>
    ${imgs.map(x => `<div class="receipt-img"><p><strong>#${x.n}</strong> ${x.r.date} · ${esc(x.r.merchant)} · ${money(x.r.amount, x.r.currency)}</p><img src="${x.url}" alt=""></div>`).join('')}
  `;

  await Promise.all([...report.querySelectorAll('img')].map(img =>
    img.complete ? null : new Promise(res => { img.onload = img.onerror = res; })));
  window.print();
}

/* ---------- Backup / restore ---------- */

const menu = $('#menu');
$('#menuBtn').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
document.addEventListener('click', () => { menu.hidden = true; });
menu.onclick = (e) => e.stopPropagation();

menu.querySelector('[data-action=backup]').onclick = async () => {
  menu.hidden = true;
  const [trips, receipts, photos] = await Promise.all([getAll('trips'), getAll('receipts'), getAll('photos')]);
  const photoData = [];
  for (const p of photos) photoData.push({ id: p.id, data: await blobToDataURL(p.blob) });
  const json = JSON.stringify({ app: 'trip-receipts', version: 1, exportedAt: new Date().toISOString(), trips, receipts, photos: photoData });
  download(`receipts-backup-${today()}.json`, json, 'application/json');
};

const restoreInput = $('#restoreInput');
menu.querySelector('[data-action=restore]').onclick = () => { menu.hidden = true; restoreInput.click(); };
restoreInput.onchange = async () => {
  const file = restoreInput.files[0];
  restoreInput.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'trip-receipts') throw new Error('Not a Trip Receipts backup file.');
    if (!confirm(`Restore ${data.trips.length} trip(s) and ${data.receipts.length} receipt(s)? Existing items with the same ID will be overwritten; others are kept.`)) return;
    for (const t of data.trips) await put('trips', t);
    for (const r of data.receipts) await put('receipts', r);
    for (const p of data.photos) await put('photos', { id: p.id, blob: await dataURLToBlob(p.data) });
    alert('Restore complete.');
    render();
  } catch (err) {
    alert('Could not restore: ' + err.message);
  }
};

/* ---------- Boot ---------- */

// Ask the browser not to evict our data when storage is low.
if (navigator.storage?.persist) navigator.storage.persist();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
