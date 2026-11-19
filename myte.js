'use strict';
/* myTE helper: matches Amex card lines to receipts and lays out everything needed
   to fill in each myTE expense (copy buttons + the receipt photo to drag/download).
   Loaded after app.js and scan.js and uses their helpers. */

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Team Snacks'];

// The client / attendees from the most recent receipt in this trip, so you only type them once.
async function defaultMyte(tripId) {
  const rs = (await receiptsFor(tripId))
    .filter(r => r.myte && (r.myte.client || r.myte.external || r.myte.attendees))
    .sort((a, b) => b.createdAt - a.createdAt);
  const m = rs[0]?.myte || {};
  return { mealType: '', reason: '', attendees: m.attendees ?? null, external: m.external || '', client: m.client || '' };
}

// Past values for the myTE fields, for autocomplete.
async function myteSuggestions() {
  const all = await getAll('receipts');
  const uniq = (k) => [...new Set(all.map(r => r.myte?.[k]).filter(Boolean))].sort();
  return {
    mealType: [...new Set([...MEAL_TYPES, ...uniq('mealType')])],
    reason: uniq('reason'), external: uniq('external'), client: uniq('client'),
  };
}

/* ---------- Dates & amounts ---------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad2 = (n) => String(n).padStart(2, '0');
const DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b|\b(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2,4})\b/;

function parseDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && v > 30000 && v < 80000) { // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400e3));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  const m = String(v).match(DATE_RE);
  if (!m) return '';
  const year = (y) => (y.length === 2 ? '20' + y : y);
  if (m[1]) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4]) return `${year(m[6])}-${pad2(m[5])}-${pad2(m[4])}`; // UK order: day/month/year
  const mon = MONTHS.indexOf(m[8].toLowerCase());
  return mon < 0 ? '' : `${year(m[9])}-${pad2(mon + 1)}-${pad2(m[7])}`;
}

function parseAmount(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/[£€$\s]|GBP|EUR|USD/gi, '').replace(/,(?=\d{3}\b)/g, '');
  const neg = /^\(.*\)$/.test(s);
  const m = s.replace(/[()]/g, '').match(/^-?\d+(\.\d+)?$/);
  return m ? (neg ? -1 : 1) * parseFloat(m[0]) : null;
}

const ukDate = (d) => (d ? d.split('-').reverse().join('/') : '');
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);

/* ---------- Reading Amex lines (Excel/CSV export, or pasted text) ---------- */

const EXPENSE_TYPE_RE = /(--\s*select one\s*--|meals and entertainment|accommodation\s*-\s*\w+|travel\s*-\s*[\w ]+?(?=\s{2,}|\t|$)|per diem[\w -]*|telephone[\w -]*|other)\s*$/i;

function lineId(l) { return `${l.date}|${l.amount.toFixed(2)}|${l.detail.toUpperCase()}`; }
function withIds(lines) {
  const seen = {};
  return lines.map(l => {
    const base = lineId(l);
    seen[base] = (seen[base] || 0) + 1;
    return { ...l, id: seen[base] > 1 ? `${base}#${seen[base]}` : base };
  });
}

// Rows of cells (from Excel or CSV). Uses the header row when there is one.
function linesFromRows(rows) {
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const head = rows[h].map(c => String(c ?? '').toLowerCase().trim());
    const di = head.findIndex(c => /date/.test(c));
    const ai = head.findIndex(c => /amount/.test(c));
    const ti = head.findIndex(c => /detail|description|merchant|narrative|vendor|supplier/.test(c));
    if (di < 0 || ai < 0) continue;
    const ei = head.findIndex(c => /expense type|type/.test(c));
    const out = [];
    for (const row of rows.slice(h + 1)) {
      const date = parseDate(row[di]);
      const amount = parseAmount(row[ai]);
      if (!date || amount == null) continue;
      const detail = String(ti >= 0 ? row[ti] ?? '' :
        row.filter((c, i) => i !== di && i !== ai && typeof c === 'string').sort((a, b) => b.length - a.length)[0] || '').trim();
      out.push({ date, amount, detail, type: ei >= 0 && ei !== ti ? String(row[ei] ?? '').trim() : '' });
    }
    if (out.length) return out;
  }
  // No header found: treat it like pasted text.
  return linesFromText(rows.map(r => r.join('\t')).join('\n'));
}

// Free text: every date starts a new line; the last x.xx number in it is the amount.
function linesFromText(text) {
  const re = new RegExp(DATE_RE.source, 'g');
  const starts = [...text.matchAll(re)].map(m => m.index);
  const out = [];
  starts.forEach((s, i) => {
    let chunk = text.slice(s, starts[i + 1] ?? text.length);
    const date = parseDate(chunk);
    chunk = chunk.replace(DATE_RE, '').replace(/^\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i, '');
    const amounts = [...chunk.matchAll(/-?[£€$]?\d[\d,]*\.\d{2}\b/g)];
    if (!date || !amounts.length) return;
    const last = amounts[amounts.length - 1];
    const amount = parseAmount(last[0]);
    let rest = chunk.slice(0, last.index).replace(/[\t\r\n]+/g, '  ').trim();
    const t = rest.match(EXPENSE_TYPE_RE);
    let type = '';
    if (t && t.index > 0) { type = /select one/i.test(t[1]) ? '' : t[1].trim(); rest = rest.slice(0, t.index); }
    out.push({ date, amount, detail: rest.replace(/\s+/g, ' ').trim(), type });
  });
  return out;
}

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

let xlsxPromise;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return xlsxPromise ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => { xlsxPromise = null; rej(new Error('Could not load the Excel reader (offline?). Use "Paste lines" instead.')); };
    document.head.appendChild(s);
  });
}

async function readAmexFile(file) {
  if (/\.(xlsx|xls|xlsm|ods)$/i.test(file.name)) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer());
    let lines = [];
    for (const name of wb.SheetNames) {
      lines = lines.concat(linesFromRows(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })));
    }
    return lines;
  }
  const text = await file.text();
  return /\.(csv|tsv)$/i.test(file.name) ? linesFromRows(parseCSV(text)) : linesFromText(text);
}

async function saveAmexLines(trip, lines) {
  if (!lines.length) {
    alert('No card lines found. Each line needs a date (e.g. 31/10/2026) and an amount (e.g. 13.00).');
    return;
  }
  trip.amex = { importedAt: Date.now(), lines: withIds(lines) };
  trip.amexLinks = trip.amexLinks || {};
  await put('trips', trip);
  render();
}

function pasteAmexDialog(trip) {
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Paste Amex lines</h2>
      <p class="muted" style="margin-top:0">In myTE, open <strong>Amex Import</strong>, select the rows of the table with your mouse,
        copy (⌘C / Ctrl+C) and paste here. Rows copied from the exported Excel file work too.
        Do the same for page 2 if there is one.</p>
      <textarea name="text" style="min-height:200px" placeholder="06/11/2026 Fri   AGP COSTA COFFEE 124187 MALAGA   Meals and Entertainment   13.30"></textarea>
      <label class="check"><input type="checkbox" name="append" ${trip.amex?.lines?.length ? 'checked' : ''}> Add to the lines already loaded</label>
      <div class="dialog-actions">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button class="btn primary">Load lines</button>
      </div>
    </form>`;
  $('[data-cancel]', dialog).onclick = () => dialog.close();
  $('form', dialog).onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    let lines = linesFromText(form.text.value);
    if (form.append.checked && trip.amex?.lines) lines = mergeLines(trip.amex.lines, lines);
    dialog.close();
    await saveAmexLines(trip, lines);
  };
  dialog.showModal();
}

function mergeLines(oldLines, newLines) {
  const have = new Set(oldLines.map(lineId));
  return [...oldLines.map(({ id, ...l }) => l), ...newLines.filter(l => !have.has(lineId(l)))];
}

const amexInput = document.createElement('input');
amexInput.type = 'file';
amexInput.accept = '.xlsx,.xls,.csv,.tsv,.txt,.ods';
amexInput.hidden = true;
document.body.appendChild(amexInput);

async function importAmexFile(trip, file) {
  try {
    let lines = await readAmexFile(file);
    if (trip.amex?.lines?.length && lines.length &&
        confirm(`Found ${lines.length} lines. Add them to the ${trip.amex.lines.length} already loaded?\n\nOK = add, Cancel = replace`)) {
      lines = mergeLines(trip.amex.lines, lines);
    }
    await saveAmexLines(trip, lines);
  } catch (err) {
    alert('Could not read that file: ' + err.message);
  }
}

/* ---------- Matching card lines to receipts ---------- */

const STOP = new Set(['the', 'and', 'https', 'http', 'www', 'com', 'help', 'ltd', 'limited', 'restaurante', 'restaurant', 'cafe', 'bar']);
const words = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z]+/g, ' ').split(' ').filter(w => w.length >= 3 && !STOP.has(w));

function matchScore(line, r) {
  if (!r.date || !line.date) return 0;
  const days = Math.abs(dayDiff(line.date, r.date));
  if (days > 4) return 0; // card lines can post a day or two after the receipt
  const exact = [r.amount, r.homeAmount].some(a => a != null && Math.abs(a - line.amount) < 0.015);
  const near = r.homeAmount != null && Math.abs(r.homeAmount - line.amount) <= Math.max(0.5, line.amount * 0.04);
  if (!exact && !near) return 0;
  const lw = words(line.detail), rw = words(r.merchant);
  const named = rw.some(w => lw.some(x => x.startsWith(w) || w.startsWith(x)));
  return (exact ? 60 : 35) + (named ? 25 : 0) + (10 - days * 2);
}

// Returns Map(lineId → receipt). Manual choices (trip.amexLinks) win; the rest is matched best-first.
function matchLines(trip, lines, receipts) {
  const links = trip.amexLinks || {};
  const result = new Map();
  const used = new Set();
  for (const l of lines) {
    const rid = links[l.id];
    const r = rid && receipts.find(x => x.id === rid);
    if (r) { result.set(l.id, r); used.add(r.id); }
  }
  const pairs = [];
  for (const l of lines) {
    if (links[l.id] !== undefined) continue; // chosen by hand (a receipt, "none" or hidden)
    for (const r of receipts) {
      if (used.has(r.id)) continue;
      const s = matchScore(l, r);
      if (s > 0) pairs.push({ l, r, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  for (const { l, r } of pairs) {
    if (result.has(l.id) || used.has(r.id)) continue;
    result.set(l.id, r); used.add(r.id);
  }
  return result;
}

/* ---------- Page ---------- */

const CAT_TO_MYTE = {
  food: 'Meals and Entertainment', taxi: 'Travel - Taxi', transport: 'Travel - Train/Bus', flight: 'Travel - Air',
  hotel: 'Accommodation - Hotel', car: 'Travel - Car/Fuel', parking: 'Travel - Parking/Tolls', other: 'Other',
};

function receiptFileName(r) {
  const ext = r._blobType === 'application/pdf' ? 'pdf' : 'jpg';
  return `${ukDate(r.date).replace(/\//g, '-')} ${safeName(r.merchant || 'receipt').replace(/_/g, ' ')} ${(r.amount || 0).toFixed(2)} ${r.currency}.${ext}`;
}

function field(label, value, copyValue = value) {
  if (value == null || value === '') return '';
  return `<div class="mf"><span class="k">${esc(label)}</span>
    <span class="v" data-copy="${esc(copyValue)}" title="Click to copy">${esc(value)}</span>
    <button type="button" class="copy" data-copy="${esc(copyValue)}">Copy</button></div>`;
}

async function receiptBlock(trip, r, line) {
  const p = r.photoId ? await get('photos', r.photoId) : null;
  r._blobType = p?.blob.type;
  const m = r.myte || {};
  const isFood = r.category === 'food';
  let photo = `<div class="mphoto none">No photo<br><button type="button" class="btn" data-edit="${esc(r.id)}">Add one</button></div>`;
  if (p) {
    const url = photoUrl(p.blob);
    const name = receiptFileName(r);
    photo = `<div class="mphoto">
      ${p.blob.type.startsWith('image/') ? `<img src="${url}" alt="Receipt" draggable="true" data-dl="${esc(p.blob.type)}:${esc(name)}:${url}" title="Drag into myTE's upload box, or onto your desktop">` : '<div style="font-size:2.5rem">📄</div>'}
      <a class="btn" href="${url}" download="${esc(name)}">⬇️ Download</a>
    </div>`;
  }
  const foreign = r.currency !== trip.currency;
  return `<div class="mreceipt">
    ${photo}
    <div class="mfields">
      ${line ? '' : field('Expense type', CAT_TO_MYTE[r.category] || 'Other')}
      ${field(isFood ? 'Restaurant / place' : 'Merchant', r.merchant)}
      ${field('Date', ukDate(r.date))}
      ${field('Amount', `${(r.amount || 0).toFixed(2)} ${r.currency}`, (r.amount || 0).toFixed(2))}
      ${foreign && r.homeAmount != null ? field(`In ${trip.currency}`, r.homeAmount.toFixed(2)) : ''}
      ${isFood ? field('Type of meal', m.mealType) : ''}
      ${field(isFood ? 'Reason / other' : 'Description', m.reason || r.notes)}
      ${isFood ? field('No. of attendees', m.attendees) : ''}
      ${isFood ? field('External attendees', m.external) : ''}
      ${isFood ? field('Client name', m.client) : ''}
      ${m.reason && r.notes && m.reason !== r.notes ? field('Notes', r.notes) : ''}
      ${isFood && !(m.mealType && m.attendees) ? `<p class="muted" style="margin:6px 0 0">Tip: add the meal type and attendees with ✏️ so they're here to copy.</p>` : ''}
      <div style="margin-top:8px"><button type="button" class="btn" data-edit="${esc(r.id)}">✏️ Edit receipt</button></div>
    </div>
  </div>`;
}

async function renderMyte(id) {
  const trip = await get('trips', id);
  if (!trip) { location.hash = '#/'; return; }
  titleEl.textContent = 'myTE: ' + trip.name;
  backBtn.hidden = false;
  fab.hidden = true;
  view.classList.add('wide');

  const receipts = (await receiptsFor(id)).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  const lines = [...(trip.amex?.lines || [])].sort((a, b) => a.date.localeCompare(b.date));
  const links = trip.amexLinks || {};
  const matches = matchLines(trip, lines, receipts);

  // Lines well outside the trip (e.g. a phone bill) go to the bottom, as do ones you hid.
  const inTrip = (l) => !trip.start || (dayDiff(l.date, trip.start) >= -3 && (!trip.end || dayDiff(l.date, trip.end) <= 3));
  const hidden = (l) => links[l.id] === 'hide' || (links[l.id] === undefined && !matches.has(l.id) && !inTrip(l));
  const active = lines.filter(l => !hidden(l));
  const others = lines.filter(hidden);
  const matchedIds = new Set([...matches.values()].map(r => r.id));
  const unmatched = receipts.filter(r => !matchedIds.has(r.id));
  const needReceipt = active.filter(l => !matches.has(l.id)).length;

  const choose = (l) => {
    const cur = links[l.id] || ''; // only show a choice you made by hand
    return `<select class="pick" data-line="${esc(l.id)}">
      <option value="">${matches.has(l.id) ? 'Change receipt…' : 'Pick the receipt…'}</option>
      ${receipts.map(r => `<option value="${esc(r.id)}" ${r.id === cur ? 'selected' : ''}>${esc(ukDate(r.date))} · ${esc(r.merchant || 'receipt')} · ${(r.amount || 0).toFixed(2)} ${esc(r.currency)}</option>`).join('')}
      <option value="none">— No receipt for this line —</option>
      <option value="hide" ${cur === 'hide' ? 'selected' : ''}>— Not part of this trip —</option>
      ${links[l.id] !== undefined ? '<option value="auto">↺ Match automatically</option>' : ''}
    </select>`;
  };

  const lineCard = async (l) => {
    const r = matches.get(l.id);
    return `<div class="card mline ${r ? '' : 'missing'}">
      <div class="mhead">
        <div class="grow"><div class="name">${esc(l.detail || 'Card line')}</div>
          <div class="muted">${esc(ukDate(l.date))}${l.type ? ' · ' + esc(l.type) : ''}</div></div>
        <div class="amount">${l.amount.toFixed(2)}</div>
      </div>
      ${r ? await receiptBlock(trip, r, l) : `<p class="warn-text">${links[l.id] === 'none' ? 'Marked as no receipt (tick "Missing Receipt" in myTE).' : '⚠️ No receipt found for this line.'}</p>`}
      <div class="mpick">${choose(l)}</div>
    </div>`;
  };

  let html = `
    <div class="card">
      <h2 style="margin:0 0 6px;font-size:1.1rem">Fill in myTE</h2>
      <ol class="muted steps">
        <li>In myTE, open <strong>Amex Import</strong>, tick your trip's lines and <strong>Import</strong>.
          Also click <strong>Export</strong> there and load that file below (or copy the table and paste it).</li>
        <li>For each expense in myTE, copy the details from here and <strong>drag the receipt photo</strong> onto its
          "Drag and Drop to Upload" box. If dragging doesn't work, use ⬇️ Download and then Upload.</li>
      </ol>
      <div class="actions" style="margin:10px 0 0">
        <button class="btn primary" data-act="amex-file">📄 Load Amex export</button>
        <button class="btn" data-act="amex-paste">📋 Paste lines</button>
        ${lines.length ? '<button class="btn danger" data-act="amex-clear">Clear card lines</button>' : ''}
      </div>
      ${lines.length ? `<p style="margin:10px 0 0"><strong>${active.length - needReceipt} of ${active.length}</strong> card lines matched to a receipt
        ${needReceipt ? ` · <span class="warn-text">${needReceipt} still need one</span>` : ' ✅'}
        ${unmatched.length ? ` · ${unmatched.length} receipt${unmatched.length === 1 ? '' : 's'} not on the card` : ''}</p>` : ''}
    </div>`;

  if (lines.length) {
    html += `<h3 class="section">Amex card lines</h3>`;
    for (const l of active) html += await lineCard(l);
  }
  if (unmatched.length) {
    html += `<h3 class="section">${lines.length ? 'Receipts not on the Amex card' : 'Receipts'}</h3>
      ${lines.length ? '<p class="muted">Paid personally or in cash, or the card line hasn\'t been loaded. Add these in myTE with "Expenses to Add".</p>' : ''}`;
    for (const r of unmatched) {
      html += `<div class="card mline"><div class="mhead"><div class="grow"><div class="name">${esc(r.merchant || 'Receipt')}</div>
        <div class="muted">${esc(ukDate(r.date))} · ${r.payment === 'personal' ? 'Paid personally' : 'Company card'}</div></div>
        <div class="amount">${(r.amount || 0).toFixed(2)} ${esc(r.currency)}</div></div>${await receiptBlock(trip, r)}</div>`;
    }
  }
  if (others.length) {
    html += `<details class="section"><summary>Other card lines (${others.length}) — outside the trip dates or hidden</summary>`;
    for (const l of others) html += await lineCard(l);
    html += '</details>';
  }
  if (!lines.length && !receipts.length) html += `<div class="empty"><div class="big">🧾</div><p>No receipts in this trip yet.</p></div>`;
  view.innerHTML = html;

  view.querySelectorAll('[data-copy]').forEach(el => el.onclick = async () => {
    try { await navigator.clipboard.writeText(el.dataset.copy); } catch { return alert('Copy failed: ' + el.dataset.copy); }
    const btn = el.classList.contains('copy') ? el : el.nextElementSibling;
    btn.textContent = 'Copied ✓'; btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1200);
  });
  view.querySelectorAll('img[data-dl]').forEach(img => img.addEventListener('dragstart', (e) => {
    // Lets Chrome/Edge save the photo when it's dropped on the desktop or in Finder.
    e.dataTransfer.setData('DownloadURL', img.dataset.dl);
  }));
  view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => receiptDialog(trip, receipts.find(r => r.id === b.dataset.edit)));
  view.querySelectorAll('select.pick').forEach(sel => sel.onchange = async () => {
    if (!sel.value) return;
    const l = { ...(trip.amexLinks || {}) };
    if (sel.value === 'auto') delete l[sel.dataset.line];
    else {
      // A receipt can only belong to one line.
      for (const k of Object.keys(l)) if (l[k] === sel.value && !['none', 'hide'].includes(sel.value)) delete l[k];
      l[sel.dataset.line] = sel.value;
    }
    trip.amexLinks = l;
    await put('trips', trip);
    render();
  });
  $('[data-act=amex-file]').onclick = () => {
    amexInput.value = '';
    amexInput.onchange = () => amexInput.files[0] && importAmexFile(trip, amexInput.files[0]);
    amexInput.click();
  };
  $('[data-act=amex-paste]').onclick = () => pasteAmexDialog(trip);
  const clear = $('[data-act=amex-clear]');
  if (clear) clear.onclick = async () => {
    if (!confirm('Remove the loaded Amex lines (and your manual matches)? Receipts are not affected.')) return;
    delete trip.amex; delete trip.amexLinks;
    await put('trips', trip);
    render();
  };
}
