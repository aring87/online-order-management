'use strict';

const $ = (s) => document.querySelector(s);
const money = (c) => `$${((c || 0) / 100).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = { new: 'New', preparing: 'Preparing', ready: 'Ready', picked_up: 'Picked up / Delivered', cancelled: 'Cancelled' };
const when = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString([], { dateStyle: 'medium' }) : '—';
const day = (s) => s ? new Date(s + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
const badge = (st) => `<span class="badge ${st}">${STATUSES[st] || st}</span>`;
const qty = (it) => it.unit === 'lb' ? `${it.quantity} lb` : `${it.quantity}`;
const todayISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const SOURCES = { online: 'Online', manual: 'Entered by staff', import: 'Imported from Excel' };

class AuthError extends Error {}

async function api(url, opts = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { showLogin(); throw new AuthError('Please log in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const showError = (el, msg) => { el.textContent = msg || ''; el.classList.toggle('hidden', !msg); };

// ================= Login =================
function showLogin() {
  for (const id of ['#app', '#refresh', '#logout', '#export']) $(id).classList.add('hidden');
  $('#view-login').classList.remove('hidden');
  $('#password').focus();
}
function showApp() {
  $('#view-login').classList.add('hidden');
  for (const id of ['#app', '#refresh', '#logout', '#export']) $(id).classList.remove('hidden');
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError($('#login-error'), '');
  const res = await fetch('/api/admin/login', jsonOpts('POST', { password: $('#password').value })).catch(() => null);
  if (!res || !res.ok) {
    showError($('#login-error'), res ? (await res.json().catch(() => ({}))).error || 'Could not log in' : 'Could not reach the server.');
    return;
  }
  $('#password').value = '';
  showApp();
  route();
});
$('#logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ================= Views & routing =================
const VIEWS = ['customers', 'orders', 'new', 'import'];
function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('hidden', v !== view);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  location.hash = b.dataset.view === 'customers' ? '' : b.dataset.view;
}));
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) location.hash = go.dataset.goto === 'customers' ? '' : go.dataset.goto;
});

async function route({ quiet = false } = {}) {
  const h = location.hash.slice(1);
  const m = h.match(/^customer\/(\d+)$/);
  try {
    if (m || h === '') {
      show('customers');
      await loadCustomers();
      if (m) await loadCustomer(m[1], { quiet }); else clearCustomer();
    } else if (h === 'orders') { show('orders'); await loadOrders(); }
    else if (h.startsWith('new')) { show('new'); if (!quiet) startNewOrder(new URLSearchParams(h.split('?')[1]).get('customer')); }
    else if (h === 'import') { show('import'); }
    else { location.hash = ''; }
  } catch (err) { if (!(err instanceof AuthError)) console.error(err); }
}
window.addEventListener('hashchange', () => route());
$('#refresh').addEventListener('click', () => route({ quiet: true }));

// ================= Customers =================
let customers = [];
let selectedId = null;
let searchTimer;

async function loadCustomers() {
  const q = $('#search').value.trim();
  customers = await api(`/api/admin/customers?q=${encodeURIComponent(q)}`);
  $('#customers-empty').classList.toggle('hidden', customers.length > 0 || q !== '');
  $('#customer-count').textContent = q
    ? `${customers.length} match${customers.length === 1 ? '' : 'es'} for "${q}"`
    : `${customers.length} customer${customers.length === 1 ? '' : 's'}`;
  $('#customer-list').innerHTML = customers.map((c) => `
    <li><a href="#customer/${c.id}" class="${String(c.id) === String(selectedId) ? 'selected' : ''}">
      <span class="c-name">${esc(c.name)}${c.open_orders ? ` <span class="badge new">${c.open_orders} open</span>` : ''}</span>
      <span class="c-meta">${esc(c.phone || c.email || '')}</span>
      <span class="c-meta">${c.order_count} order${c.order_count === 1 ? '' : 's'} · last ${when(c.last_order_at)}</span>
    </a></li>`).join('');
}
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadCustomers().catch(() => {}), 200);
});

function clearCustomer() {
  selectedId = null;
  $('#customer-detail').classList.add('hidden');
  $('#customer-placeholder').classList.remove('hidden');
  $('#view-customers').classList.remove('has-selection');
  document.querySelectorAll('#customer-list a.selected').forEach((a) => a.classList.remove('selected'));
}

function statusSelect(order) {
  return `<select class="status" data-order="${order.id}" aria-label="Status for order ${order.id}">
    ${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === order.status ? 'selected' : ''}>${v}</option>`).join('')}
  </select>`;
}

function renderOrder(o) {
  const meta = [
    `Ordered ${when(o.created_at)}`,
    o.pickup_date ? `${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'} ${day(o.pickup_date)}` : (o.fulfillment === 'delivery' ? 'Delivery' : ''),
    SOURCES[o.source] || '',
    o.order_ref ? `Ref ${esc(o.order_ref)}` : '',
  ].filter(Boolean).join(' · ');
  return `
  <div class="order" id="order-${o.id}">
    <div class="order-head">
      <div><span class="title">Order #${o.id}</span> ${badge(o.status)}<div class="muted">${meta}</div></div>
      <div class="order-actions">${statusSelect(o)}<button type="button" class="link danger" data-delete="${o.id}">Delete</button></div>
    </div>
    ${o.delivery_address ? `<p class="notes"><b class="muted">Deliver to:</b> ${esc(o.delivery_address)}</p>` : ''}
    ${o.notes ? `<p class="notes"><b class="muted">Notes:</b> ${esc(o.notes)}</p>` : ''}
    <table class="stack items">
      <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th>Cut instructions</th><th class="num">Total</th></tr></thead>
      <tbody>
        ${o.items.map((it) => `<tr>
          <td class="primary">${esc(it.product_name)}</td>
          <td data-label="Qty" class="num">${qty(it)}</td>
          <td data-label="Price" class="num">${money(it.unit_price_cents)}${it.unit === 'lb' ? '/lb' : ''}</td>
          <td data-label="Cut" class="${it.cut_instructions ? 'cut-note' : 'hide-mobile'}">${esc(it.cut_instructions) || '<span class="muted">—</span>'}</td>
          <td data-label="Total" class="num">${money(it.line_total_cents)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="order-total"><span>Order total</span><b>${money(o.total_cents)}</b></div>
  </div>`;
}

async function loadCustomer(id, { quiet = false } = {}) {
  selectedId = id;
  $('#view-customers').classList.add('has-selection');
  $('#customer-placeholder').classList.add('hidden');
  $('#customer-detail').classList.remove('hidden');
  document.querySelectorAll('#customer-list a').forEach((a) => a.classList.toggle('selected', a.getAttribute('href') === `#customer/${id}`));
  if (!quiet) { $('#customer-head').innerHTML = '<p class="muted">Loading…</p>'; $('#customer-orders').innerHTML = ''; }

  let c;
  try { c = await api(`/api/admin/customers/${id}`); }
  catch (err) { if (!(err instanceof AuthError)) $('#customer-head').textContent = err.message; return; }
  const spent = c.orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total_cents, 0);
  const open = c.orders.filter((o) => ['new', 'preparing', 'ready'].includes(o.status)).length;
  $('#customer-head').innerHTML = `
    <h2>${esc(c.name)}</h2>
    <div class="contact">
      ${c.phone ? `<a href="tel:${esc(c.phone)}">📞 ${esc(c.phone)}</a>` : ''}
      ${c.email ? `<a href="mailto:${esc(c.email)}">✉️ ${esc(c.email)}</a>` : ''}
      ${!c.phone && !c.email ? '<span class="muted">No phone or email on file</span>' : ''}
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${c.orders.length}</div><div class="l">Orders</div></div>
      <div class="stat"><div class="v">${open}</div><div class="l">Open</div></div>
      <div class="stat"><div class="v">${money(spent)}</div><div class="l">Total spent</div></div>
      <div class="stat"><div class="v">${when(c.orders.map((o) => o.created_at).sort()[0] || c.created_at)}</div><div class="l">Customer since</div></div>
    </div>`;
  $('#customer-orders').innerHTML = c.orders.length ? c.orders.map(renderOrder).join('') : '<p class="muted">No orders.</p>';
}

$('#back').addEventListener('click', () => { location.hash = ''; });
$('#add-for-customer').addEventListener('click', () => { location.hash = `new?customer=${selectedId}`; });

// Status changes and deletes (customer page and all-orders list)
document.addEventListener('change', async (e) => {
  if (!e.target.matches('select.status')) return;
  const sel = e.target;
  sel.disabled = true;
  try {
    const o = await api(`/api/admin/orders/${sel.dataset.order}`, jsonOpts('PATCH', { status: sel.value }));
    const b = sel.closest('.order, tr')?.querySelector('.badge');
    if (b) b.outerHTML = badge(o.status);
  } catch (err) { if (!(err instanceof AuthError)) alert(`Could not update: ${err.message}`); }
  finally { sel.disabled = false; }
});
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete]');
  if (!btn) return;
  if (!confirm(`Delete order #${btn.dataset.delete}? This can't be undone.`)) return;
  try {
    await api(`/api/admin/orders/${btn.dataset.delete}`, { method: 'DELETE' });
    route({ quiet: true });
  } catch (err) { if (!(err instanceof AuthError)) alert(`Could not delete: ${err.message}`); }
});

// ================= All orders =================
$('#status-filter').innerHTML += Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
async function loadOrders() {
  const params = new URLSearchParams({ status: $('#status-filter').value, q: $('#order-search').value.trim() });
  const list = await api(`/api/admin/orders?${params}`);
  $('#orders-empty').classList.toggle('hidden', list.length > 0);
  $('#orders-body').innerHTML = list.map((o) => `
    <tr>
      <td class="primary"><b>#${o.id}</b><span class="mobile-only"> · <a href="#customer/${o.customer_id}">${esc(o.customer_name)}</a></span></td>
      <td data-label="Date">${when(o.created_at)}${o.pickup_date ? `<div class="muted">${o.fulfillment === 'delivery' ? 'Deliver' : 'Pickup'} ${day(o.pickup_date)}</div>` : ''}</td>
      <td data-label="Customer" class="hide-mobile"><a href="#customer/${o.customer_id}"><b>${esc(o.customer_name)}</b></a><div class="muted">${esc(o.customer_phone || o.customer_email || '')}</div></td>
      <td data-label="Items" class="items-cell">${esc(o.item_summary)}</td>
      <td data-label="Total" class="num">${money(o.total_cents)}</td>
      <td data-label="Status">${statusSelect(o)}</td>
    </tr>`).join('');
}
$('#status-filter').addEventListener('change', () => loadOrders().catch(() => {}));
let orderSearchTimer;
$('#order-search').addEventListener('input', () => {
  clearTimeout(orderSearchTimer);
  orderSearchTimer = setTimeout(() => loadOrders().catch(() => {}), 200);
});

// ================= New order =================
let products = [];
$('#n-status').innerHTML = Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

async function startNewOrder(customerId) {
  $('#new-form').reset();
  showError($('#new-error'), '');
  $('#n-match').classList.add('hidden');
  $('#n-date').value = todayISO();
  $('#n-items').innerHTML = '';
  $('#n-address-field').classList.add('hidden');
  addItemRow();
  try {
    if (!products.length) products = await api('/api/products');
    $('#product-names').innerHTML = products.map((p) => `<option value="${esc(p.name)}"></option>`).join('');
    const all = await api('/api/admin/customers');
    customers = all;
    $('#customer-names').innerHTML = all.map((c) => `<option value="${esc(c.name)}">${esc(c.phone || c.email || '')}</option>`).join('');
    if (customerId) {
      const c = all.find((x) => String(x.id) === String(customerId));
      if (c) { $('#n-name').value = c.name; $('#n-phone').value = c.phone || ''; $('#n-email').value = c.email || ''; showMatch(c); }
    }
  } catch (err) { if (!(err instanceof AuthError)) console.error(err); }
  $('#n-name').focus();
}

function showMatch(c) {
  $('#n-match').innerHTML = c ? `✓ Existing customer — this order will be added to <b>${esc(c.name)}</b>'s history.` : '';
  $('#n-match').classList.toggle('hidden', !c);
}
$('#n-name').addEventListener('change', () => {
  const name = $('#n-name').value.trim().toLowerCase();
  const c = customers.find((x) => x.name.toLowerCase() === name);
  if (c) {
    if (!$('#n-phone').value) $('#n-phone').value = c.phone || '';
    if (!$('#n-email').value) $('#n-email').value = c.email || '';
  }
  showMatch(c);
});
$('#n-fulfillment').addEventListener('change', (e) => $('#n-address-field').classList.toggle('hidden', e.target.value !== 'delivery'));

function addItemRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td data-label="Item"><input class="i-name" list="product-names" placeholder="e.g. Ribeye Steak" aria-label="Item"></td>
    <td data-label="Qty"><input class="i-qty" type="number" min="0" step="any" value="1" aria-label="Quantity"></td>
    <td data-label="Unit"><select class="i-unit" aria-label="Unit"><option value="lb">lb</option><option value="each">each</option></select></td>
    <td data-label="Price ($)"><input class="i-price" type="number" min="0" step="0.01" placeholder="0.00" aria-label="Price per unit"></td>
    <td data-label="Cut"><input class="i-cut" placeholder="optional" aria-label="Cut instructions"></td>
    <td data-label="Total" class="num i-total">$0.00</td>
    <td><button type="button" class="link danger i-remove" aria-label="Remove item">✕</button></td>`;
  $('#n-items').appendChild(tr);
  tr.querySelector('.i-name').focus();
}
$('#n-add-item').addEventListener('click', addItemRow);
$('#n-items').addEventListener('click', (e) => {
  if (!e.target.matches('.i-remove')) return;
  e.target.closest('tr').remove();
  if (!$('#n-items').children.length) addItemRow();
  updateNewTotal();
});
$('#n-items').addEventListener('change', (e) => {
  if (!e.target.matches('.i-name')) return;
  // Fill in price & unit from the product list.
  const p = products.find((x) => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
  const tr = e.target.closest('tr');
  if (p) {
    tr.querySelector('.i-unit').value = p.unit;
    if (!tr.querySelector('.i-price').value) tr.querySelector('.i-price').value = (p.price_cents / 100).toFixed(2);
  }
  updateNewTotal();
});
$('#n-items').addEventListener('input', updateNewTotal);

function newOrderItems() {
  return [...$('#n-items').children].map((tr) => ({
    name: tr.querySelector('.i-name').value.trim(),
    quantity: Number(tr.querySelector('.i-qty').value),
    unit: tr.querySelector('.i-unit').value,
    unit_price_cents: Math.round(Number(tr.querySelector('.i-price').value || 0) * 100),
    cut_instructions: tr.querySelector('.i-cut').value.trim(),
    tr,
  }));
}
function updateNewTotal() {
  let total = 0;
  for (const it of newOrderItems()) {
    const line = Math.round((it.quantity || 0) * it.unit_price_cents);
    it.tr.querySelector('.i-total').textContent = money(line);
    if (it.name) total += line;
  }
  $('#n-total').textContent = money(total);
}

$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError($('#new-error'), '');
  const items = newOrderItems().filter((it) => it.name).map(({ tr, ...it }) => it);
  if (!items.length) return showError($('#new-error'), 'Add at least one item.');
  const btn = e.submitter || $('#new-form button[type=submit]');
  btn.disabled = true;
  try {
    const o = await api('/api/admin/orders', jsonOpts('POST', {
      name: $('#n-name').value, phone: $('#n-phone').value, email: $('#n-email').value,
      order_date: $('#n-date').value, pickup_date: $('#n-pickup').value, status: $('#n-status').value,
      fulfillment: $('#n-fulfillment').value, delivery_address: $('#n-address').value, notes: $('#n-notes').value,
      items,
    }));
    location.hash = `customer/${o.customer_id}`;
  } catch (err) {
    if (!(err instanceof AuthError)) showError($('#new-error'), err.message);
    window.scrollTo(0, 0);
  } finally { btn.disabled = false; }
});

// ================= Import from Excel =================
let fields = [];
let sheet = null;   // { headers, rows, mapping, sheets, sheet }
let importFile = null;

function importStep(n) {
  for (const i of [1, 2, 3]) $(`#import-step${i}`).classList.toggle('hidden', i !== n);
}

async function previewFile(file, sheetName) {
  showError($('#import-error'), '');
  importFile = file;
  $('#file-drop span').innerHTML = `Reading <b>${esc(file.name)}</b>…`;
  try {
    if (!fields.length) fields = await api('/api/admin/import/fields');
    const qs = new URLSearchParams({ filename: file.name, sheet: sheetName || '' });
    sheet = await api(`/api/admin/import/preview?${qs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
  } catch (err) {
    if (!(err instanceof AuthError)) showError($('#import-error'), err.message);
    $('#file-drop span').innerHTML = '<b>Click to choose a file</b> or drag it here';
    $('#import-file').value = '';
    return;
  }
  $('#file-drop span').innerHTML = '<b>Click to choose a file</b> or drag it here';
  renderMapping();
  importStep(2);
}

function renderMapping() {
  $('#import-file-info').textContent = `${importFile.name}${sheet.sheet ? ` — sheet "${sheet.sheet}"` : ''} · ${sheet.rows.length} rows`;
  $('#sheet-field').classList.toggle('hidden', (sheet.sheets || []).length < 2);
  $('#import-sheet').innerHTML = (sheet.sheets || []).map((s) => `<option ${s === sheet.sheet ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const colOptions = (sel) => `<option value="">— not in sheet —</option>` +
    sheet.headers.map((h, i) => `<option value="${i}" ${String(sel) === String(i) ? 'selected' : ''}>${esc(h)}</option>`).join('');
  $('#mapping').innerHTML = fields.map((f) => `
    <label class="map-row ${sheet.mapping[f.key] != null ? 'mapped' : ''}">
      <span>${esc(f.label)}${['customer_name', 'product'].includes(f.key) ? ' *' : ''}</span>
      <select data-field="${f.key}">${colOptions(sheet.mapping[f.key])}</select>
    </label>`).join('');
  $('#import-rowcount').textContent = sheet.rows.length;
  renderPreview();
}

function cellDisplay(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00/.test(v)) return v.slice(0, 10);
  return v;
}
function renderPreview() {
  const mappedCols = new Map(Object.entries(sheet.mapping).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [Number(v), k]));
  const label = (k) => fields.find((f) => f.key === k)?.label;
  $('#import-preview').innerHTML = `
    <thead><tr>${sheet.headers.map((h, i) => `<th class="${mappedCols.has(i) ? 'mapped' : 'unmapped'}">${esc(h)}${mappedCols.has(i) ? `<div class="maps-to">→ ${esc(label(mappedCols.get(i)))}</div>` : '<div class="maps-to">not imported</div>'}</th>`).join('')}</tr></thead>
    <tbody>${sheet.rows.slice(0, 8).map((r) => `<tr>${r.map((v, i) => `<td class="${mappedCols.has(i) ? '' : 'unmapped'}">${esc(cellDisplay(v))}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

$('#mapping').addEventListener('change', (e) => {
  const f = e.target.dataset.field;
  if (!f) return;
  if (e.target.value === '') delete sheet.mapping[f]; else sheet.mapping[f] = Number(e.target.value);
  e.target.closest('.map-row').classList.toggle('mapped', e.target.value !== '');
  renderPreview();
});
$('#import-sheet').addEventListener('change', (e) => previewFile(importFile, e.target.value));
$('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) previewFile(e.target.files[0]); });
const drop = $('#file-drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) previewFile(e.dataTransfer.files[0]); });

function resetImport() {
  sheet = null; importFile = null;
  $('#import-file').value = '';
  showError($('#import-error'), '');
  showError($('#import-error2'), '');
  importStep(1);
}
$('#import-cancel').addEventListener('click', resetImport);
$('#import-again').addEventListener('click', resetImport);

$('#import-go').addEventListener('click', async () => {
  showError($('#import-error2'), '');
  const btn = $('#import-go');
  btn.disabled = true;
  btn.firstChild.textContent = 'Importing… ';
  try {
    const r = await api('/api/admin/import', jsonOpts('POST', {
      headers: sheet.headers, rows: sheet.rows, mapping: sheet.mapping, status: $('#import-status').value,
    }));
    const parts = [
      `<b>${r.orders_created}</b> order${r.orders_created === 1 ? '' : 's'} imported (${r.items_created} items)`,
      `<b>${r.customers_created}</b> new customer${r.customers_created === 1 ? '' : 's'}`,
    ];
    if (r.duplicates) parts.push(`${r.duplicates} already imported before — skipped`);
    $('#import-result').innerHTML = `<h3 style="margin-top:0;color:inherit">Import finished</h3><p style="margin:0">${parts.join(' · ')}</p>`;
    $('#import-skipped').innerHTML = r.skipped.length ? `
      <h3>${r.skipped.length} row${r.skipped.length === 1 ? '' : 's'} not imported</h3>
      <table><thead><tr><th>Row</th><th>Reason</th></tr></thead><tbody>
      ${r.skipped.slice(0, 200).map((s) => `<tr><td>${s.row}</td><td>${esc(s.reason)}</td></tr>`).join('')}
      </tbody></table>` : '';
    importStep(3);
  } catch (err) {
    if (!(err instanceof AuthError)) showError($('#import-error2'), err.message);
  } finally {
    btn.disabled = false;
    btn.firstChild.textContent = 'Import ';
  }
});

// ================= Start =================
setInterval(() => {
  const busy = document.activeElement?.matches('input, select, textarea');
  const h = location.hash.slice(1);
  if (!$('#app').classList.contains('hidden') && !document.hidden && !busy && !h.startsWith('new') && h !== 'import') route({ quiet: true });
}, 60000);

fetch('/api/admin/session').then((r) => {
  if (r.ok) { showApp(); route(); } else showLogin();
}).catch(() => {
  $('#view-login').classList.remove('hidden');
  showError($('#login-error'), 'Could not reach the server. Is the program running?');
});
