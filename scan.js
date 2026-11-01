'use strict';
/* Reads receipts from photos with the Claude API, and looks up exchange rates.
   Loaded after app.js and uses its helpers (get, put, compressImage, ...). */

const SCAN_MODEL = 'claude-opus-5-5';
const KEY_STORAGE = 'anthropicApiKey';
const getApiKey = () => localStorage.getItem(KEY_STORAGE) || '';

/* ---------- Exchange rates (European Central Bank data via frankfurter.dev, free, no key) ---------- */

const rateCache = {};
async function exchangeRate(from, to, date) {
  if (from === to) return 1;
  // ECB has no rates for future dates or weekends; the API returns the closest earlier day.
  const day = date && date <= today() ? date : 'latest';
  const key = `${day}:${from}:${to}`;
  if (!(key in rateCache)) {
    const res = await fetch(`https://api.frankfurter.dev/v1/${day}?from=${from}&to=${to}`);
    if (!res.ok) throw new Error('Exchange rate not available for ' + from);
    const data = await res.json();
    if (!data.rates?.[to]) throw new Error(`No ${from}→${to} rate available`);
    rateCache[key] = data.rates[to];
  }
  return rateCache[key];
}
async function convert(amount, from, to, date) {
  const rate = await exchangeRate(from, to, date);
  return Math.round(amount * rate * 100) / 100;
}

/* ---------- Claude API call ---------- */

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['receipts'],
  properties: {
    receipts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['merchant', 'date', 'total', 'currency', 'category', 'notes', 'box', 'rotation'],
        properties: {
          merchant: { type: 'string', description: 'Business name as printed, e.g. "Carrefour Express". Empty if unreadable.' },
          date: { type: 'string', description: 'YYYY-MM-DD, or empty if not visible.' },
          total: { type: 'number', description: 'Final total actually paid (tax included). 0 if unreadable.' },
          currency: { type: 'string', description: 'ISO 4217 code, e.g. EUR, GBP, USD.' },
          category: { type: 'string', enum: CATEGORIES.map(c => c.id) },
          notes: { type: 'string', description: 'Very short description, e.g. "4 coffees", "Dinner, 4 people".' },
          box: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y', 'width', 'height'],
            description: 'Bounding box of this receipt paper in the image, as fractions (0-1) of image width/height from the top-left corner.',
            properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          },
          rotation: { type: 'integer', enum: [0, 90, 180, 270], description: 'Degrees to rotate this receipt clockwise so its text reads upright.' },
        },
      },
    },
  },
};

function scanPrompt(trip) {
  const cats = CATEGORIES.map(c => `${c.id} = ${c.name}`).join(', ');
  return `This photo shows one or more paper receipts from a work trip${trip.destination ? ' to ' + trip.destination : ''}` +
    `${trip.start ? ` (trip dates ${trip.start} to ${trip.end || 'ongoing'})` : ''}. ` +
    `Receipts may be rotated, crumpled, torn or partly overlapping.

Return one entry per distinct receipt, in reading order. For each:
- merchant: the business name (not the legal company name if a trading name is shown).
- date: the transaction date as YYYY-MM-DD. Spanish/European receipts use DD/MM/YYYY.
- total: the final amount paid (the TOTAL line, tax included). Use the card payment amount if that is clearer. Do not use subtotals or tax bases.
- currency: ISO code; infer from symbols (€ = EUR, £ = GBP) or the country if no symbol is printed.
- category: one of ${cats}. Restaurants, cafés, bars and snacks are food; supermarket groceries are food; toiletries, sunscreen, pharmacy or shop items are other.
- notes: a few words on what was bought (e.g. "3 beers", "dinner, 4 people").
- box and rotation: where the receipt is in the image and how to turn it upright.

If the image contains no receipts, return an empty list. If a value is unreadable, use an empty string (or 0 for total) rather than guessing.`;
}

async function callClaude(imageBlob, trip) {
  const key = getApiKey();
  if (!key) throw new Error('No API key set.');
  const b64 = (await blobToDataURL(imageBlob)).split(',')[1];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      // The key belongs to the user and stays on their device; this header allows calling the API from a web page.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: SCAN_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageBlob.type || 'image/jpeg', data: b64 } },
          { type: 'text', text: scanPrompt(trip) },
        ],
      }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('The API key was rejected. Check it in ⋮ → Receipt reading settings.');
    if (res.status === 429) throw new Error('Too many requests right now. Wait a minute and try again.');
    if (res.status === 402 || /credit/i.test(data.error?.message || '')) throw new Error('Your Anthropic account is out of credit.');
    throw new Error(data.error?.message || `Request failed (${res.status}).`);
  }
  if (data.stop_reason === 'refusal') throw new Error('The photo could not be read.');
  if (data.stop_reason === 'max_tokens') throw new Error('Too many receipts in one photo. Try fewer per photo.');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(text);
  return parsed.receipts || [];
}

/* ---------- Image helpers ---------- */

async function loadBitmap(file) {
  // Draw through a canvas so phone EXIF rotation is applied the same way for scanning and cropping.
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

function bitmapToBlob(bmp, maxDim, quality = 0.85) {
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}

// Cut one receipt out of a group photo (with a generous margin), turn it upright and shrink it.
function cropReceipt(bmp, box, rotation, maxDim = 1600) {
  const pad = 0.03;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const x0 = clamp(box.x - pad), y0 = clamp(box.y - pad);
  const x1 = clamp(box.x + box.width + pad), y1 = clamp(box.y + box.height + pad);
  const sx = x0 * bmp.width, sy = y0 * bmp.height;
  const sw = (x1 - x0) * bmp.width, sh = (y1 - y0) * bmp.height;
  if (sw < 20 || sh < 20) return bitmapToBlob(bmp, maxDim);

  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const sideways = rotation === 90 || rotation === 270;
  const c = document.createElement('canvas');
  c.width = sideways ? h : w;
  c.height = sideways ? w : h;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotation || 0) * Math.PI / 180);
  ctx.drawImage(bmp, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

/* ---------- Settings dialog ---------- */

function scanSettingsDialog(afterSave) {
  const key = getApiKey();
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Receipt reading settings</h2>
      <p class="muted" style="margin-top:0">
        The app can read the merchant, date, total and currency off your receipt photos — even several receipts in one photo.
        It uses Claude from Anthropic, which needs your own API key.
      </p>
      <ol class="muted" style="padding-left:20px">
        <li>Create an account at <a href="https://platform.claude.com" target="_blank" rel="noopener">platform.claude.com</a> and add a little credit.</li>
        <li>Go to <strong>API keys</strong>, create a key and paste it below.</li>
      </ol>
      <p class="muted">Each photo costs roughly one or two US cents to read. Photos are sent to Anthropic only when you scan them. The key is saved on this device only.</p>
      <label>Anthropic API key</label>
      <input name="key" type="password" autocomplete="off" placeholder="sk-ant-..." value="${esc(key)}">
      <div class="dialog-actions">
        ${key ? '<button type="button" class="btn danger" data-clear>Remove key</button><span class="spacer"></span>' : ''}
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`;
  $('[data-cancel]', dialog).onclick = () => dialog.close();
  const clear = $('[data-clear]', dialog);
  if (clear) clear.onclick = () => { localStorage.removeItem(KEY_STORAGE); dialog.close(); };
  $('form', dialog).onsubmit = (e) => {
    e.preventDefault();
    const v = e.target.key.value.trim();
    if (v) localStorage.setItem(KEY_STORAGE, v); else localStorage.removeItem(KEY_STORAGE);
    dialog.close();
    if (v && afterSave) afterSave();
  };
  dialog.showModal();
}

/* ---------- Bulk scan: photos → review → save ---------- */

const scanInput = $('#scanInput');

function startScan(trip) {
  if (!getApiKey()) return scanSettingsDialog(() => startScan(trip));
  scanInput.value = '';
  scanInput.onchange = () => {
    const files = [...scanInput.files];
    if (files.length) runScan(trip, files);
  };
  scanInput.click();
}

function progressDialog(text) {
  dialog.innerHTML = `<form method="dialog" style="text-align:center">
    <div class="spinner"></div><p id="progressText">${esc(text)}</p></form>`;
  dialog.oncancel = (e) => e.preventDefault(); // keep it open while working
  if (!dialog.open) dialog.showModal();
}

async function runScan(trip, files) {
  const found = [];
  const errors = [];
  for (const [i, file] of files.entries()) {
    progressDialog(files.length > 1 ? `Reading photo ${i + 1} of ${files.length}…` : 'Reading receipts…');
    try {
      const bmp = await loadBitmap(file);
      const forApi = await bitmapToBlob(bmp, 1568);
      const items = await callClaude(forApi, trip);
      for (const it of items) {
        const photo = items.length === 1 && it.box.width > 0.6 && it.box.height > 0.6
          ? await bitmapToBlob(bmp, 1600, 0.8) // single receipt filling the photo: keep the whole photo
          : await cropReceipt(bmp, it.box, it.rotation);
        found.push({ ...it, photo });
      }
      if (!items.length) errors.push(`No receipts found in photo ${i + 1}.`);
    } catch (err) {
      errors.push(`Photo ${i + 1}: ${err.message}`);
    }
  }
  dialog.oncancel = null;

  if (!found.length) {
    dialog.close();
    alert(errors.join('\n') || 'No receipts found.');
    return;
  }

  // Convert foreign currencies to the trip currency.
  progressDialog('Looking up exchange rates…');
  for (const r of found) {
    r.currency = (r.currency || trip.currency).toUpperCase();
    r.homeAmount = r.total;
    if (r.currency !== trip.currency && r.total) {
      try { r.homeAmount = await convert(r.total, r.currency, trip.currency, r.date); }
      catch { r.homeAmount = null; }
    }
  }
  dialog.oncancel = null;
  reviewDialog(trip, found, errors);
}

async function reviewDialog(trip, found, errors) {
  const existing = await receiptsFor(trip.id);
  const isDup = (r) => existing.some(e => e.date === r.date && Math.abs((e.amount || 0) - r.total) < 0.005);

  dialog.innerHTML = `
    <form method="dialog">
      <h2>Found ${found.length} receipt${found.length === 1 ? '' : 's'}</h2>
      <p class="muted" style="margin-top:0">Check the details, fix anything that's wrong, then save.</p>
      ${errors.length ? `<p class="muted">⚠️ ${errors.map(esc).join('<br>')}</p>` : ''}
      ${found.map((r, i) => `
        <div class="review-item" data-i="${i}">
          <div class="review-head">
            <img src="${photoUrl(r.photo)}" alt="Receipt ${i + 1}" data-zoom="${i}">
            <div class="grow">
              <label class="check" style="margin:0"><input type="checkbox" name="keep" ${isDup(r) ? '' : 'checked'}> Save this one</label>
              ${isDup(r) ? '<div class="badge warn" style="margin:4px 0 0">Looks like a duplicate</div>' : ''}
              <input name="merchant" placeholder="Merchant" value="${esc(r.merchant)}" style="margin-top:6px">
            </div>
          </div>
          <div class="row">
            <div><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" value="${r.total || ''}" placeholder="Amount"></div>
            <div class="narrow"><select name="currency">${currencyOptions(r.currency)}</select></div>
          </div>
          <div class="row" style="margin-top:8px">
            <div><input name="date" type="date" value="${esc(r.date)}"></div>
            <div><select name="category">${CATEGORIES.map(c => `<option value="${c.id}" ${c.id === r.category ? 'selected' : ''}>${c.emoji} ${c.name}</option>`).join('')}</select></div>
          </div>
          <div style="margin-top:8px">
            <div><select name="payment">
              <option value="company">Company card</option>
              <option value="personal">Personal</option>
            </select></div>
          </div>
          <div class="home-amount" ${r.currency === trip.currency ? 'hidden' : ''}>
            <label>In ${esc(trip.currency)} (from exchange rate — edit to match your statement)</label>
            <input name="homeAmount" type="number" inputmode="decimal" step="0.01" min="0" value="${r.homeAmount ?? ''}">
          </div>
          <input name="notes" placeholder="Notes" value="${esc(r.notes)}" style="margin-top:8px">
        </div>`).join('')}
      <label>Paid with (all)</label>
      <select id="payAll"><option value="">— set each individually —</option><option value="company">Company card</option><option value="personal">Personal (reimburse me)</option></select>
      <div class="dialog-actions">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button class="btn primary">Save receipts</button>
      </div>
    </form>`;

  const items = [...dialog.querySelectorAll('.review-item')];
  $('#payAll').onchange = (e) => { if (e.target.value) items.forEach(el => { el.querySelector('[name=payment]').value = e.target.value; }); };
  for (const el of items) {
    const r = found[+el.dataset.i];
    const cur = el.querySelector('[name=currency]');
    const amt = el.querySelector('[name=amount]');
    const date = el.querySelector('[name=date]');
    const home = el.querySelector('[name=homeAmount]');
    const refresh = async () => {
      el.querySelector('.home-amount').hidden = cur.value === trip.currency;
      if (cur.value === trip.currency || !amt.value) return;
      try { home.value = await convert(parseFloat(amt.value), cur.value, trip.currency, date.value); } catch { /* leave as is */ }
    };
    cur.onchange = refresh; amt.onchange = refresh; date.onchange = refresh;
    el.querySelector('[data-zoom]').onclick = () => window.open(URL.createObjectURL(r.photo), '_blank');
  }
  $('[data-cancel]', dialog).onclick = () => { if (confirm('Discard these scanned receipts?')) dialog.close(); };

  $('form', dialog).onsubmit = async (e) => {
    e.preventDefault();
    let saved = 0;
    for (const el of items) {
      if (!el.querySelector('[name=keep]').checked) continue;
      const r = found[+el.dataset.i];
      const v = (n) => el.querySelector(`[name=${n}]`).value;
      const amount = parseFloat(v('amount')) || 0;
      const currency = v('currency');
      const h = parseFloat(v('homeAmount'));
      const photoId = uid();
      await put('photos', { id: photoId, blob: r.photo });
      await put('receipts', {
        id: uid(), tripId: trip.id, createdAt: Date.now() + saved,
        date: v('date') || today(), merchant: v('merchant').trim(), category: v('category'),
        amount, currency,
        homeAmount: currency === trip.currency ? amount : (isNaN(h) ? null : h),
        payment: v('payment'), reimbursed: false, notes: v('notes').trim(), photoId,
      });
      saved++;
    }
    dialog.close();
    render();
  };
  if (!dialog.open) dialog.showModal();
}

/* ---------- Single receipt: fill the form from its photo ---------- */

async function fillFormFromPhoto(form, blob, trip, statusEl) {
  if (!getApiKey()) return false;
  statusEl.textContent = '✨ Reading receipt…';
  try {
    const bmp = await loadBitmap(blob);
    const [r] = await callClaude(await bitmapToBlob(bmp, 1568), trip);
    if (!r) { statusEl.textContent = 'No receipt found in the photo.'; return false; }
    if (r.merchant) form.merchant.value = r.merchant;
    if (r.date) form.date.value = r.date;
    if (r.total) form.amount.value = r.total;
    if (r.notes && !form.notes.value) form.notes.value = r.notes;
    const radio = form.querySelector(`input[name=category][value="${r.category}"]`);
    if (radio) radio.checked = true;
    if (r.currency) {
      const cur = r.currency.toUpperCase();
      if (![...form.currency.options].some(o => o.value === cur)) form.currency.add(new Option(cur, cur));
      form.currency.value = cur;
      form.currency.dispatchEvent(new Event('change'));
    }
    statusEl.textContent = '✨ Filled in from the photo. Please check.';
    return true;
  } catch (err) {
    statusEl.textContent = '⚠️ ' + err.message;
    return false;
  }
}
