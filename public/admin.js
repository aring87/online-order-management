'use strict';

const $ = (s) => document.querySelector(s);
const money = (c) => `$${((c || 0) / 100).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = { new: 'New', preparing: 'Preparing', ready: 'Ready', picked_up: 'Picked up / Delivered', cancelled: 'Cancelled' };
const when = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString([], { dateStyle: 'medium' }) : '—';
const day = (s) => s ? new Date(s + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
const badge = (st) => `<span class="badge ${st}">${STATUSES[st] || st}</span>`;
const paid = (o) => (o.payment_status === 'paid' ? '<span class="badge paid" title="Paid online with Stripe">💳 Paid</span>' : '');
const qty = (it) => it.unit === 'lb' ? `${it.quantity} lb` : `${it.quantity}`;
const todayISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const SOURCES = { online: 'Online', manual: 'Entered by staff', import: 'Imported from Excel' };
const clock = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
// The order number everyone uses ("number 47") — shown big on tickets and the prep board.
// The number staff call out. Orders with a pickup slot use their pickup number for that day
// (slot 1 = #1-10, slot 2 = #11-20…); others use their permanent order number, shown with an outline.
const pickupNo = (o) => (o.slot_number != null ? o.slot_number : o.id);
const num = (o, size = '') => (o.slot_number != null
  ? `<span class="onum ${size}" title="Pickup number for ${o.pickup_date ? day(o.pickup_date) : 'the day'} (order ${o.id})">${o.slot_number}</span>`
  : `<span class="onum plain ${size}" title="Order number (no pickup number)">${o.id}</span>`);
const orderRefTxt = (o) => (o.slot_number != null ? `Order ${o.id}` : '');
// ---- Half-hour pickup slots ----
let pickupHours = { open: '10:00', close: '18:00', slot_minutes: 30 };
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// The slot a pickup time falls in: "10:47" → "10:30" (for 30-minute slots)
const slotStart = (t) => (t ? hhmm(Math.floor(toMin(t) / pickupHours.slot_minutes) * pickupHours.slot_minutes) : null);
// Pickup numbers belonging to a slot: first slot #1-10, second #11-20…
function slotRange(start) {
  if (!start) return '';
  const idx = (toMin(start) - toMin(pickupHours.open)) / pickupHours.slot_minutes;
  if (idx < 0 || toMin(start) + pickupHours.slot_minutes > toMin(pickupHours.close)) return '';
  const size = pickupHours.slot_max > 0 ? pickupHours.slot_max : 10;
  return `#${idx * size + 1}–${idx * size + size}`;
}
const slotLabel = (start) => (start ? `${clock(start)} – ${clock(hhmm(toMin(start) + pickupHours.slot_minutes))}` : 'No pickup time');
function slotList() {
  const out = [];
  for (let m = toMin(pickupHours.open); m + pickupHours.slot_minutes <= toMin(pickupHours.close); m += pickupHours.slot_minutes) out.push(hhmm(m));
  return out;
}
function fillSlotSelects() {
  const opts = slotList().map((s) => `<option value="${s}">${slotLabel(s)}</option>`).join('');
  $('#n-time').innerHTML = `<option value="">Any time</option>${opts}`;
  $('#t-slot').innerHTML = `<option value="">All day</option>${opts}<option value="none">No pickup time set</option>`;
}
fillSlotSelects();
fetch('/api/settings').then((r) => r.json()).then((s) => { if (s.pickup) { pickupHours = s.pickup; fillSlotSelects(); } }).catch(() => {});

// "Today 3:30 PM", "Tomorrow", "Tue, Dec 1" — with overdue / today highlighting.
function due(o) {
  if (!o.pickup_date) return { text: o.fulfillment === 'delivery' ? 'Delivery — no date' : 'No pickup date', cls: 'none' };
  const today = todayISO();
  const tmr = new Date(Date.now() + 864e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const label = o.pickup_date === today ? 'Today' : o.pickup_date === tmr ? 'Tomorrow'
    : new Date(o.pickup_date + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const verb = o.fulfillment === 'delivery' ? 'Deliver' : 'Pickup';
  return {
    text: `${verb} ${label}${o.pickup_time ? ` · ${clock(o.pickup_time)}` : ''}`,
    cls: o.pickup_date < today ? 'late' : o.pickup_date === today ? 'today' : '',
  };
}

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
  for (const id of ['#app', '#refresh', '#logout', '#export', '#alerts']) $(id).classList.add('hidden');
  stopLive();
  $('#view-login').classList.remove('hidden');
  $('#password').focus();
}
function showApp() {
  $('#view-login').classList.add('hidden');
  for (const id of ['#app', '#refresh', '#logout', '#export']) $(id).classList.remove('hidden');
  updateAlertsButton();
  startLive();
  refreshCounts();
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
const VIEWS = ['board', 'online', 'customers', 'orders', 'slots', 'totals', 'new', 'import'];
function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('hidden', v !== view);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  location.hash = b.dataset.view === 'board' ? '' : b.dataset.view;
}));
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) location.hash = go.dataset.goto === 'board' ? '' : go.dataset.goto;
});

async function route({ quiet = false } = {}) {
  const h = location.hash.slice(1);
  const m = h.match(/^customer\/(\d+)$/);
  try {
    if (h === '') { show('board'); await loadBoard(); }
    else if (h === 'online') { show('online'); await loadOnline(); }
    else if (m || h === 'customers') {
      show('customers');
      await loadCustomers();
      if (m) await loadCustomer(m[1], { quiet }); else clearCustomer();
    } else if (h === 'orders') { show('orders'); await loadOrders(); }
    else if (h === 'totals') { show('totals'); await loadTotals(); }
    else if (h === 'slots') { show('slots'); await loadSlots(); }
    else if (h.startsWith('new')) { show('new'); if (!quiet) startNewOrder(new URLSearchParams(h.split('?')[1]).get('customer')); }
    else if (h === 'import') { show('import'); }
    else { location.hash = ''; }
    showLoadError('');
  } catch (err) {
    if (err instanceof AuthError) return;
    console.error(err);
    showLoadError(err.message);
  }
}
// Never leave a screen silently blank: say what went wrong and the usual fix.
function showLoadError(msg) {
  let box = $('#load-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'load-error';
    box.className = 'error load-error';
    $('#app').prepend(box);
  }
  box.classList.toggle('hidden', !msg);
  if (msg) {
    box.innerHTML = `<b>This screen couldn't load</b> (${esc(msg)}).
      If you just updated the program, it needs a restart: Start menu → <b>Stop Butcher Shop Orders</b>
      (or close the black window), then open it again.`;
  }
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
    orderRefTxt(o),
    `Ordered ${when(o.created_at)}`,
    o.pickup_date ? `${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'} ${day(o.pickup_date)}${o.pickup_time ? ` ${clock(o.pickup_time)}` : ''}` : (o.fulfillment === 'delivery' ? 'Delivery' : ''),
    SOURCES[o.source] || '',
    o.order_ref ? `Ref ${esc(o.order_ref)}` : '',
  ].filter(Boolean).join(' · ');
  return `
  <div class="order" id="order-${o.id}">
    <div class="order-head">
      <div class="order-title">${num(o)}<div>${badge(o.status)} ${paid(o)}<div class="muted">${meta}</div></div></div>
      <div class="order-actions">${statusSelect(o)}<button type="button" class="secondary small" data-print="${o.id}">🖨 Ticket</button><button type="button" class="link danger" data-delete="${o.id}">Delete</button></div>
    </div>
    ${o.delivery_address ? `<p class="notes"><b class="muted">Deliver to:</b> ${esc(o.delivery_address)}</p>` : ''}
    ${o.notes ? `<p class="notes"><b class="muted">Notes:</b> ${esc(o.notes)}</p>` : ''}
    <table class="stack items">
      <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th>Cut instructions</th><th class="num">Total</th></tr></thead>
      <tbody>
        ${o.items.map((it) => `<tr>
          <td class="primary">${esc(it.product_name)}</td>
          <td data-label="Qty" class="num">${qty(it)}${it.actual_quantity != null ? `<div class="w-actual">⚖ ${it.actual_quantity}${it.unit === 'lb' ? ' lb' : ''}</div>` : ''}</td>
          <td data-label="Price" class="num">${money(it.unit_price_cents)}${it.unit === 'lb' ? '/lb' : ''}</td>
          <td data-label="Cut" class="${it.cut_instructions ? 'cut-note' : 'hide-mobile'}">${esc(it.cut_instructions) || '<span class="muted">—</span>'}</td>
          <td data-label="Total" class="num">${money(it.line_total_cents)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="order-total"><span>Order total</span><b>${money(o.total_cents)}</b></div>
    ${weighBar(o)}
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

$('#back').addEventListener('click', () => { location.hash = 'customers'; });
$('#add-for-customer').addEventListener('click', () => { location.hash = `new?customer=${selectedId}`; });

// Status changes and deletes (customer page and all-orders list)
document.addEventListener('change', async (e) => {
  if (!e.target.matches('select.status')) return;
  const sel = e.target;
  sel.disabled = true;
  try {
    const o = await api(`/api/admin/orders/${sel.dataset.order}`, jsonOpts('PATCH', { status: sel.value }));
    const b = sel.closest('.order, tr, .ticket')?.querySelector('.badge');
    if (b) b.outerHTML = badge(o.status);
    refreshCounts();
    if (location.hash === '#orders') loadOrders().catch(() => {});
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

// ================= Orders: organize by customer / item / pickup day / order =================
const prefs = (() => { try { return JSON.parse(localStorage.getItem('orders-view') || '{}'); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('orders-view', JSON.stringify(prefs)); } catch { /* ignore */ } };
prefs.group ||= 'customer';
$('#f-show').innerHTML += Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">Only: ${v}</option>`).join('');
for (const [id, key] of [['#f-show', 'show'], ['#f-when', 'when'], ['#f-source', 'source']]) {
  if (prefs[key] && [...$(id).options].some((o) => o.value === prefs[key])) $(id).value = prefs[key];
}
let browseOrders = [];

function setGroup(g) {
  prefs.group = g; savePrefs();
  document.querySelectorAll('#group-by [data-group]').forEach((b) => {
    b.classList.toggle('active', b.dataset.group === g);
    b.setAttribute('aria-checked', b.dataset.group === g);
  });
}
setGroup(prefs.group);
$('#group-by').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (b) { setGroup(b.dataset.group); renderBrowse(); }
});

function browseParams() {
  const p = new URLSearchParams({ show: $('#f-show').value, q: $('#order-search').value.trim() });
  if ($('#f-source').value) p.set('source', $('#f-source').value);
  const t = todayISO();
  const plus = (n) => new Date(Date.parse(t + 'T12:00') + n * 864e5).toISOString().slice(0, 10);
  switch ($('#f-when').value) {
    case 'overdue': p.set('to', plus(-1)); break;
    case 'today': p.set('from', t); p.set('to', t); break;
    case 'tomorrow': p.set('from', plus(1)); p.set('to', plus(1)); break;
    case 'week': p.set('from', t); p.set('to', plus(6)); break;
    case 'nodate': p.set('nodate', '1'); break;
    default:
  }
  return p;
}

async function loadOrders() {
  browseOrders = await api(`/api/admin/orders/browse?${browseParams()}`);
  renderBrowse();
}
for (const [id, key] of [['#f-show', 'show'], ['#f-when', 'when'], ['#f-source', 'source']]) {
  $(id).addEventListener('change', () => { prefs[key] = $(id).value; savePrefs(); loadOrders().catch(() => {}); });
}
let orderSearchTimer;
$('#order-search').addEventListener('input', () => {
  clearTimeout(orderSearchTimer);
  orderSearchTimer = setTimeout(() => loadOrders().catch(() => {}), 200);
});

// Total amount of an item across orders, e.g. "48.5 lb + 2"
function totalQty(lines) {
  const sum = { lb: 0, each: 0 };
  for (const l of lines) sum[l.unit === 'lb' ? 'lb' : 'each'] += l.quantity;
  const r = (n) => Math.round(n * 100) / 100;
  return [sum.lb ? `${r(sum.lb)} lb` : '', sum.each ? `${r(sum.each)}${sum.lb ? ' each' : ''}` : ''].filter(Boolean).join(' + ');
}
const statusCell = (o, print) => (print ? (STATUSES[o.status] || o.status) : statusSelect(o));
const dueCell = (o) => { const d = due(o); return `<span class="due-txt ${d.cls}">${esc(d.text)}</span>`; };
const custLink = (o, print) => (print ? esc(o.customer_name) : `<a href="#customer/${o.customer_id}">${esc(o.customer_name)}</a>`);
const itemsInline = (o) => o.items.map((it) =>
  `<span class="iline${it.packed ? ' packed' : ''}"><b>${esc(qty(it))}</b> ${esc(it.product_name)}${it.cut_instructions ? ` <span class="cut-inline">✂ ${esc(it.cut_instructions)}</span>` : ''}</span>`).join('');

function groupHtml(title, sub, body, cls = '') {
  return `<section class="group ${cls}"><header class="group-head"><div class="g-title">${title}</div><div class="g-sub">${sub}</div></header>${body}</section>`;
}

function renderByCustomer(orders, print) {
  const groups = new Map();
  for (const o of orders) {
    if (!groups.has(o.customer_id)) groups.set(o.customer_id, []);
    groups.get(o.customer_id).push(o);
  }
  return [...groups.values()]
    .sort((a, b) => a[0].customer_name.localeCompare(b[0].customer_name, undefined, { sensitivity: 'base' }))
    .map((list) => {
      const c = list[0];
      const total = list.reduce((s, o) => s + o.total_cents, 0);
      return groupHtml(
        `${custLink(c, print)}${c.customer_phone ? ` <span class="muted">${esc(c.customer_phone)}</span>` : ''}`,
        `${list.length} order${list.length === 1 ? '' : 's'} · ${money(total)}`,
        `<table class="stack gtable"><tbody>${list.map((o) => `<tr>
          <td class="primary w-num">${num(o)}</td>
          <td data-label="Items" class="items-col">${itemsInline(o)}${o.notes ? `<div class="g-note">📝 ${esc(o.notes)}</div>` : ''}</td>
          <td data-label="Pickup" class="w-due">${dueCell(o)} ${paid(o)}</td>
          <td data-label="Total" class="num w-money">${money(o.total_cents)}</td>
          <td data-label="Status" class="w-status">${statusCell(o, print)}</td></tr>`).join('')}</tbody></table>`);
    }).join('');
}

function renderByItem(orders, print) {
  const q = $('#order-search').value.trim().toLowerCase();
  const groups = new Map();
  for (const o of orders) {
    for (const it of o.items) {
      const key = it.product_name.trim().toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: it.product_name.trim(), lines: [] });
      groups.get(key).lines.push({ ...it, order: o });
    }
  }
  let list = [...groups.values()];
  // Searching for an item ("brisket") shows just that item, not everything else on those orders.
  if (q && list.some((g) => g.name.toLowerCase().includes(q))) list = list.filter((g) => g.name.toLowerCase().includes(q));
  return list
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((g) => {
      const packed = g.lines.filter((l) => l.packed).length;
      return groupHtml(
        `${esc(g.name)} <span class="g-total">${esc(totalQty(g.lines))}</span>`,
        `${g.lines.length} order${g.lines.length === 1 ? '' : 's'}${packed ? ` · ${packed} packed` : ''}`,
        `<table class="stack gtable"><tbody>${g.lines.map((l) => `<tr class="${l.packed ? 'packed' : ''}">
          <td class="primary w-num">${print ? '<span class="pbox">☐</span>' : `<input type="checkbox" data-item="${l.id}" ${l.packed ? 'checked' : ''} aria-label="Packed">`} ${num(l.order)}</td>
          <td data-label="Qty" class="w-qty"><b>${esc(qty(l))}</b></td>
          <td data-label="Customer" class="w-cust">${custLink(l.order, print)}</td>
          <td data-label="Cut" class="items-col">${l.cut_instructions ? `<span class="cut-inline">✂ ${esc(l.cut_instructions)}</span>` : '<span class="muted">—</span>'}</td>
          <td data-label="Pickup" class="w-due">${dueCell(l.order)}</td>
          <td data-label="Status" class="w-status">${print ? STATUSES[l.order.status] : badge(l.order.status)}</td></tr>`).join('')}</tbody></table>`);
    }).join('');
}

function dayKey(o) {
  if (!o.pickup_date) return { key: 'zzzz', label: 'No pickup date' };
  const t = todayISO();
  if (o.pickup_date < t && ['new', 'preparing', 'ready'].includes(o.status)) return { key: '0000', label: 'Overdue', cls: 'late' };
  const d = due({ ...o, pickup_time: null });
  const label = new Date(o.pickup_date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const prefix = o.pickup_date === t ? 'Today · ' : d.text.includes('Tomorrow') ? 'Tomorrow · ' : '';
  return { key: o.pickup_date, label: prefix + label, cls: o.pickup_date === t ? 'today' : '' };
}

// Sort a day's orders by pickup time and put a heading row before each half-hour slot.
function withSlotRows(list, skip) {
  const sorted = [...list].sort((a, b) => (a.pickup_time || '99') .localeCompare(b.pickup_time || '99') || a.id - b.id);
  if (skip) return sorted;
  const out = [];
  let current;
  for (const o of sorted) {
    const s = slotStart(o.pickup_time) || 'none';
    if (s !== current) {
      current = s;
      const range = s !== 'none' && slotRange(s) ? ` · ${slotRange(s)}` : '';
      out.push({ slotRow: true, label: slotLabel(s === 'none' ? null : s) + range, count: sorted.filter((x) => (slotStart(x.pickup_time) || 'none') === s).length });
    }
    out.push(o);
  }
  return out;
}

function renderByDay(orders, print) {
  const groups = new Map();
  for (const o of orders) {
    const k = dayKey(o);
    if (!groups.has(k.key)) groups.set(k.key, { ...k, list: [] });
    groups.get(k.key).list.push(o);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map((g) => groupHtml(
    `<span class="${g.cls || ''}">${esc(g.label)}</span>`,
    `${g.list.length} order${g.list.length === 1 ? '' : 's'}`,
    `<table class="stack gtable"><tbody>${withSlotRows(g.list, g.key === '0000').map((o) => o.slotRow ? `<tr class="slot-row"><td colspan="6">🕐 ${esc(o.label)} <span class="muted">· ${o.count} order${o.count === 1 ? '' : 's'}</span></td></tr>` : `<tr>
      <td class="primary w-num">${num(o)}</td>
      <td data-label="Time" class="w-time">${o.pickup_time ? clock(o.pickup_time) : '<span class="muted">—</span>'}${g.key === '0000' ? `<div class="muted">${new Date(o.pickup_date + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>` : ''}</td>
      <td data-label="Customer" class="w-cust">${custLink(o, print)}${o.customer_phone ? `<div class="muted">${esc(o.customer_phone)}</div>` : ''}</td>
      <td data-label="Items" class="items-col">${itemsInline(o)}</td>
      <td data-label="Total" class="num w-money">${money(o.total_cents)} ${paid(o)}</td>
      <td data-label="Status" class="w-status">${statusCell(o, print)}</td></tr>`).join('')}</tbody></table>`, g.cls)).join('');
}

function renderByOrder(orders, print) {
  const sorted = [...orders].sort((a, b) => b.id - a.id);
  return `<table class="stack gtable flat">
    <thead><tr><th>#</th><th>Customer</th><th>Items</th><th>Pickup</th><th class="num">Total</th><th>Status</th></tr></thead>
    <tbody>${sorted.map((o) => `<tr>
      <td class="primary w-num">${num(o)}<span class="mobile-only"> · ${custLink(o, print)}</span></td>
      <td data-label="Customer" class="w-cust hide-mobile">${custLink(o, print)}<div class="muted">${esc(o.customer_phone || o.customer_email || '')}</div></td>
      <td data-label="Items" class="items-col">${itemsInline(o)}</td>
      <td data-label="Pickup" class="w-due">${dueCell(o)}</td>
      <td data-label="Total" class="num w-money">${money(o.total_cents)} ${paid(o)}</td>
      <td data-label="Status" class="w-status">${statusCell(o, print)}</td></tr>`).join('')}</tbody></table>`;
}

const RENDER = { customer: renderByCustomer, item: renderByItem, day: renderByDay, order: renderByOrder };

function filtersText() {
  const parts = [$('#f-show').selectedOptions[0].text, $('#f-when').selectedOptions[0].text];
  if ($('#f-source').value) parts.push($('#f-source').selectedOptions[0].text);
  if ($('#order-search').value.trim()) parts.push(`matching "${$('#order-search').value.trim()}"`);
  return parts.join(' · ');
}

function renderBrowse() {
  const list = browseOrders;
  const total = list.reduce((s, o) => s + o.total_cents, 0);
  const customers = new Set(list.map((o) => o.customer_id)).size;
  $('#orders-summary').textContent = list.length
    ? `${list.length} order${list.length === 1 ? '' : 's'} · ${customers} customer${customers === 1 ? '' : 's'} · ${money(total)} — ${filtersText()}`
    : '';
  $('#orders-empty').classList.toggle('hidden', list.length > 0);
  $('#orders-out').className = `browse by-${prefs.group}`;
  $('#orders-out').innerHTML = list.length ? RENDER[prefs.group](list, false) : '';
}

$('#print-list').addEventListener('click', () => {
  const names = { customer: 'by customer', item: 'by item (cut list)', day: 'by pickup day', order: 'by order number' };
  $('#print-area').innerHTML = `
    <div class="pl">
      <h1>Orders ${names[prefs.group]}</h1>
      <p class="pl-meta">${esc(filtersText())} · ${browseOrders.length} orders · printed ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
      <div class="browse by-${prefs.group}">${RENDER[prefs.group](browseOrders, true)}</div>
    </div>`;
  window.print();
});

// ================= Pickup slots =================
$('#sl-date').value = todayISO();
const shiftDay = (iso, n) => new Date(Date.parse(iso + 'T12:00:00') + n * 864e5).toISOString().slice(0, 10);

async function loadSlots() {
  const date = $('#sl-date').value || todayISO();
  const d = await api(`/api/admin/slots?date=${date}`);
  const t = todayISO();
  const rel = date === t ? 'Today · ' : date === shiftDay(t, 1) ? 'Tomorrow · ' : '';
  $('#sl-title').textContent = `${rel}${new Date(date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`
    + (d.closed ? ' · Closed' : d.close && d.close !== pickupHours.close ? ` · open until ${clock(d.close)}` : '');
  const used = d.slots.filter((s) => s.count);
  const busiest = used.reduce((m, s) => (s.count > (m?.count || 0) ? s : m), null);
  $('#sl-stats').innerHTML = `
    <div class="stat"><div class="v">${d.total}</div><div class="l">Orders this day</div></div>
    <div class="stat"><div class="v">${d.slots.filter((s) => s.full).length}</div><div class="l">Full slots</div></div>
    <div class="stat"><div class="v">${d.max || '∞'}</div><div class="l">Max per slot (online)</div></div>
    ${busiest ? `<div class="stat"><div class="v">${clock(busiest.start)}</div><div class="l">Busiest slot (${busiest.count})</div></div>` : ''}`;
  $('#sl-grid').innerHTML = (d.closed ? `<div class="slot-closed">🔒 Closed on ${esc(d.day)}s. Customers can't book pickups this day.${d.total ? ' Orders staff booked anyway are shown below.' : ''}</div>` : '') + d.slots.map((s) => {
    const pct = s.max ? Math.min(100, Math.round((s.count / s.max) * 100)) : 0;
    const level = s.full ? 'full' : pct >= 70 ? 'busy' : s.count ? 'some' : 'empty';
    return `<div class="slot-card ${level}">
      <div class="slot-head"><b>${clock(s.start)} – ${clock(s.end)}${s.numbers ? ` <span class="slot-range">#${s.numbers.first}–${s.numbers.last}</span>` : ''}</b>
        <span class="slot-count">${s.count}${s.max ? ` / ${s.max}` : ''}${s.full ? ' · FULL' : ''}</span></div>
      ${s.max ? `<div class="slot-bar"><span style="width:${pct}%"></span></div>` : ''}
      ${s.orders.length ? `<ul class="slot-orders">${s.orders.map((o) => `<li><a href="#customer/${o.customer_id}">${num(o)} ${esc(o.customer_name)}</a>
        <span class="muted">${o.item_count} item${o.item_count === 1 ? '' : 's'}</span> ${badge(o.status)}${paid(o)}</li>`).join('')}</ul>`
        : '<p class="muted slot-free">No orders</p>'}
    </div>`;
  }).join('');
  $('#sl-notime').innerHTML = d.no_time.length ? `<section class="group"><header class="group-head"><div class="g-title">No pickup time set</div>
    <div class="g-sub">${d.no_time.length} order${d.no_time.length === 1 ? '' : 's'}</div></header>
    <ul class="slot-orders" style="padding:10px 14px">${d.no_time.map((o) => `<li>${num(o)} ${esc(o.customer_name)} ${badge(o.status)}</li>`).join('')}</ul></section>` : '';
}
for (const [id, fn] of [['#sl-prev', () => shiftDay($('#sl-date').value || todayISO(), -1)], ['#sl-next', () => shiftDay($('#sl-date').value || todayISO(), 1)],
  ['#sl-today', () => todayISO()], ['#sl-tomorrow', () => shiftDay(todayISO(), 1)]]) {
  $(id).addEventListener('click', () => { $('#sl-date').value = fn(); loadSlots().catch(() => {}); });
}
$('#sl-date').addEventListener('change', () => loadSlots().catch(() => {}));

// ================= Item totals (prep list & sales) =================
const tPrefs = (() => { try { return JSON.parse(localStorage.getItem('totals-view') || '{}'); } catch { return {}; } })();
const saveT = () => { try { localStorage.setItem('totals-view', JSON.stringify(tPrefs)); } catch { /* ignore */ } };
tPrefs.mode ||= 'prep';
tPrefs.source ??= 'online';
const RANGES = {
  prep: [['tomorrow', 'Pickup tomorrow'], ['today', 'Pickup today'], ['next2', 'Today + tomorrow'], ['week', 'Next 7 days'], ['custom', 'Pick dates…']],
  sales: [['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['thismonth', 'This month'], ['lastmonth', 'Last month'],
    ['last30', 'Last 30 days'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Pick dates…']],
};
let totalsData = null;

const isoLocal = (d) => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const addDays = (n) => isoLocal(new Date(Date.now() + n * 864e5));
function rangeDates(key) {
  const now = new Date();
  switch (key) {
    case 'today': return [addDays(0), addDays(0)];
    case 'tomorrow': return [addDays(1), addDays(1)];
    case 'yesterday': return [addDays(-1), addDays(-1)];
    case 'next2': return [addDays(0), addDays(1)];
    case 'week': return [addDays(0), addDays(6)];
    case 'last7': return [addDays(-6), addDays(0)];
    case 'last30': return [addDays(-29), addDays(0)];
    case 'thismonth': return [isoLocal(new Date(now.getFullYear(), now.getMonth(), 1)), addDays(0)];
    case 'lastmonth': return [isoLocal(new Date(now.getFullYear(), now.getMonth() - 1, 1)), isoLocal(new Date(now.getFullYear(), now.getMonth(), 0))];
    case 'year': return [isoLocal(new Date(now.getFullYear(), 0, 1)), addDays(0)];
    case 'all': return ['', ''];
    default: return [$('#t-from').value, $('#t-to').value];
  }
}

function setMode(mode) {
  tPrefs.mode = mode; saveT();
  document.querySelectorAll('#t-mode [data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-checked', b.dataset.mode === mode);
  });
  $('#t-range').innerHTML = RANGES[mode].map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const saved = tPrefs[`range_${mode}`];
  $('#t-range').value = RANGES[mode].some(([k]) => k === saved) ? saved : RANGES[mode][0][0];
  $('#t-show').value = tPrefs[`show_${mode}`] || 'all';
  $('#t-slot').classList.toggle('hidden', mode !== 'prep');
  updateCustom();
}
function updateCustom() {
  const custom = $('#t-range').value === 'custom';
  $('#t-custom').classList.toggle('hidden', !custom);
  if (custom && !$('#t-from').value) {
    const [f, t] = tPrefs.mode === 'prep' ? [addDays(1), addDays(1)] : [addDays(-6), addDays(0)];
    $('#t-from').value = f; $('#t-to').value = t;
  }
}
$('#t-source').value = tPrefs.source;
setMode(tPrefs.mode);

$('#t-mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) { setMode(b.dataset.mode); loadTotals().catch(() => {}); }
});
$('#t-range').addEventListener('change', () => { tPrefs[`range_${tPrefs.mode}`] = $('#t-range').value; saveT(); updateCustom(); loadTotals().catch(() => {}); });
$('#t-show').addEventListener('change', () => { tPrefs[`show_${tPrefs.mode}`] = $('#t-show').value; saveT(); loadTotals().catch(() => {}); });
$('#t-slot').addEventListener('change', () => loadTotals().catch(() => {}));
$('#t-source').addEventListener('change', () => { tPrefs.source = $('#t-source').value; saveT(); loadTotals().catch(() => {}); });
for (const id of ['#t-from', '#t-to']) $(id).addEventListener('change', () => loadTotals().catch(() => {}));

const fmtQty = (lb, each) => [lb ? `${lb} lb` : '', each ? `${each}${lb ? ' each' : ''}` : ''].filter(Boolean).join(' + ') || '0';
const dLong = (s) => new Date(s + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
function totalsTitle() {
  const [from, to] = rangeDates($('#t-range').value);
  const what = tPrefs.mode === 'prep' ? 'Prep list' : 'Sold';
  const when = !from && !to ? 'all time' : from === to ? (tPrefs.mode === 'prep' ? `pickup ${dLong(from)}` : dLong(from))
    : `${tPrefs.mode === 'prep' ? 'pickup ' : ''}${day(from)} – ${day(to)}`;
  const slot = tPrefs.mode === 'prep' && $('#t-slot').value ? ` · ${$('#t-slot').selectedOptions[0].text}` : '';
  return `${what} · ${when}${slot} · ${$('#t-source').selectedOptions[0].text}${$('#t-show').value !== 'all' ? ` · ${$('#t-show').selectedOptions[0].text}` : ''}`;
}

async function loadTotals() {
  const [from, to] = rangeDates($('#t-range').value);
  const p = new URLSearchParams({ basis: tPrefs.mode === 'prep' ? 'pickup' : 'order', show: $('#t-show').value });
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if ($('#t-source').value) p.set('source', $('#t-source').value);
  const slot = tPrefs.mode === 'prep' ? $('#t-slot').value : '';
  if (slot === 'none') p.set('notime', '1');
  else if (slot) { p.set('time_from', slot); p.set('time_to', hhmm(toMin(slot) + pickupHours.slot_minutes)); }
  totalsData = await api(`/api/admin/reports/items?${p}`);
  renderTotals();
}

function totalsHtml(data, print) {
  const sales = tPrefs.mode === 'sales';
  const cats = [...new Set(data.items.map((i) => i.category))];
  return cats.map((cat) => {
    const items = data.items.filter((i) => i.category === cat);
    const catQty = fmtQty(Math.round(items.reduce((s, i) => s + i.lb, 0) * 100) / 100, items.reduce((s, i) => s + i.each, 0));
    return `<section class="group t-cat">
      <header class="group-head"><div class="g-title">${esc(cat)} <span class="g-total">${esc(catQty)}</span></div>
        <div class="g-sub">${items.length} item${items.length === 1 ? '' : 's'}${sales ? ` · ${money(items.reduce((s, i) => s + i.revenue_cents, 0))}` : ''}</div></header>
      <table class="t-table"><tbody>${items.map((it) => {
        const special = it.cuts.filter((c) => c.cut);
        const rows = it.cuts.length > 1 || special.length ? it.cuts.map((c) => `<tr class="t-cut">
            <td class="t-check">${print ? '☐' : ''}</td>
            <td class="t-name">${c.cut ? `<span class="cut-inline">✂ ${esc(c.cut)}</span>` : '<span class="muted">no special cut</span>'}</td>
            <td class="t-qty">${esc(fmtQty(c.lb, c.each))}</td>
            <td class="t-orders muted">${c.orders} order${c.orders === 1 ? '' : 's'}</td>
            ${sales ? '<td></td>' : ''}</tr>`).join('') : '';
        return `<tr class="t-item">
            <td class="t-check">${print && !rows ? '☐' : ''}</td>
            <td class="t-name"><b>${esc(it.name)}</b>${!print && !sales && it.packed_lines ? ` <span class="muted t-packed">${it.packed_lines}/${it.lines} packed</span>` : ''}</td>
            <td class="t-qty"><b>${esc(fmtQty(it.lb, it.each))}</b></td>
            <td class="t-orders">${it.orders} order${it.orders === 1 ? '' : 's'}</td>
            ${sales ? `<td class="t-money">${money(it.revenue_cents)}</td>` : ''}</tr>${rows}`;
      }).join('')}</tbody></table></section>`;
  }).join('');
}

function renderTotals() {
  const d = totalsData;
  $('#t-title').textContent = totalsTitle();
  $('#t-empty').classList.toggle('hidden', d.items.length > 0);
  $('#t-stats').innerHTML = d.items.length ? `
    <div class="stat"><div class="v">${d.totals.lb} lb</div><div class="l">By the pound</div></div>
    <div class="stat"><div class="v">${d.totals.each}</div><div class="l">By the piece</div></div>
    <div class="stat"><div class="v">${d.totals.items}</div><div class="l">Different items</div></div>
    <div class="stat"><div class="v">${d.totals.orders}</div><div class="l">Orders</div></div>
    ${tPrefs.mode === 'sales' ? `<div class="stat"><div class="v">${money(d.totals.revenue_cents)}</div><div class="l">Sales (est.)</div></div>` : ''}` : '';
  $('#t-out').innerHTML = totalsHtml(d, false);
}

$('#t-print').addEventListener('click', () => {
  if (!totalsData) return;
  $('#print-area').innerHTML = `<div class="pl">
    <h1>${esc(totalsTitle())}</h1>
    <p class="pl-meta">${totalsData.totals.orders} orders · ${totalsData.totals.lb} lb + ${totalsData.totals.each} pieces · printed ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
    ${totalsHtml(totalsData, true)}</div>`;
  window.print();
});

$('#t-csv').addEventListener('click', () => {
  if (!totalsData) return;
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Meat', 'Item', 'Cut', 'Pounds', 'Pieces', 'Orders', 'Sales ($)']];
  for (const it of totalsData.items) {
    lines.push([it.category, it.name, 'ALL', it.lb, it.each, it.orders, (it.revenue_cents / 100).toFixed(2)]);
    if (it.cuts.length > 1 || it.cuts.some((c) => c.cut)) {
      for (const c of it.cuts) lines.push([it.category, it.name, c.cut || '(no special cut)', c.lb, c.each, c.orders, '']);
    }
  }
  const csv = '﻿' + [[totalsTitle()], [], ...lines].map((l) => l.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${tPrefs.mode === 'prep' ? 'prep-list' : 'sales'}-${todayISO()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ================= New order =================
let products = [];
$('#n-status').innerHTML = Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

async function startNewOrder(customerId) {
  $('#new-form').reset();
  fillSlotSelects();
  nSlots = {};
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
// Show how full each slot is for the chosen pickup day (staff can still book a full slot).
let nSlots = {};
let nClosed = null;
async function refreshNewOrderSlots() {
  const date = $('#n-pickup').value;
  nSlots = {};
  nClosed = null;
  const chosen = $('#n-time').value;
  if (!date) { fillSlotSelects(); $('#n-time').value = chosen; return; }
  const d = await api(`/api/admin/slots?date=${date}`).catch(() => null);
  if (!d) return;
  for (const s of d.slots) nSlots[s.start] = s;
  if (d.closed) {
    // Closed day (e.g. Monday): staff can still book it for a special arrangement, after a warning.
    nClosed = d.day;
    fillSlotSelects();
    $('#n-time').value = chosen;
    return;
  }
  $('#n-time').innerHTML = '<option value="">Any time</option>' + d.slots.map((s) =>
    `<option value="${s.start}">${slotLabel(s.start)} — ${s.count}${s.max ? `/${s.max}` : ''} orders${s.full ? ' · FULL' : ''}</option>`).join('');
  $('#n-time').value = chosen;
}
$('#n-pickup').addEventListener('change', () => refreshNewOrderSlots());

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
  if (nClosed && !confirm(`The shop is normally closed on ${nClosed}s. Book this pickup anyway?`)) return;
  const slot = nSlots[$('#n-time').value];
  if (slot?.full && !confirm(`The ${slotLabel(slot.start)} slot already has ${slot.count} orders (max ${slot.max}). Add this order anyway?`)) return;
  const btn = e.submitter || $('#new-form button[type=submit]');
  btn.disabled = true;
  try {
    const o = await api('/api/admin/orders', jsonOpts('POST', {
      name: $('#n-name').value, phone: $('#n-phone').value, email: $('#n-email').value,
      order_date: $('#n-date').value, pickup_date: $('#n-pickup').value, pickup_time: $('#n-time').value, status: $('#n-status').value,
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
  if (typeof v === 'string' && /^1899-12-3\dT\d\d:\d\d/.test(v)) return clock(v.slice(11, 16));   // an Excel time
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

// ================= Prep board =================
const NEXT = {
  new: { status: 'preparing', label: 'Start ▶' },
  preparing: { status: 'ready', label: 'Ready ✓' },
  ready: { status: 'picked_up', label: 'Picked up ✓' },
};
let boardOrders = [];

function itemLine(it, { checkable = false } = {}) {
  const box = checkable
    ? `<input type="checkbox" data-item="${it.id}" ${it.packed ? 'checked' : ''} aria-label="Packed: ${esc(it.product_name)}">`
    : '';
  return `<li class="${it.packed ? 'packed' : ''}"><label>${box}
    <span class="q">${esc(qty(it))}</span>
    <span class="i">${esc(it.product_name)}${it.cut_instructions ? `<span class="cut">✂ ${esc(it.cut_instructions)}</span>` : ''}</span>
  </label>${checkable && it.unit === 'lb' ? weighInput(it) : ''}</li>`;
}

// ⚖ Actual weight box for a by-the-pound item, with the repriced line.
function weighInput(it) {
  const diff = it.actual_line_total_cents != null ? it.actual_line_total_cents - it.line_total_cents : null;
  return `<div class="weigh-row">⚖ <input type="number" class="w-in" data-weigh="${it.id}" min="0" step="0.01" inputmode="decimal"
      value="${it.actual_quantity ?? ''}" placeholder="actual" aria-label="Actual weight of ${esc(it.product_name)} in lb"> lb
    ${diff != null ? `<span class="w-price">${money(it.actual_line_total_cents)} <span class="${diff > 0 ? 'w-up' : diff < 0 ? 'w-down' : ''}">(${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))})</span></span>` : ''}
  </div>`;
}

// What's left to settle after weighing, with the buttons to do it.
function weighBar(o) {
  const w = o.weigh;
  if (!w || (!w.items_weighed && !w.adjustments.length)) return '';
  const amt = money(Math.abs(w.outstanding_cents));
  const head = `<div class="wb-sum">Estimated ${money(w.estimated_cents)} → weighed <b>${money(w.actual_cents)}</b>
    ${w.items_to_weigh && !w.all_weighed ? `<span class="muted">(${w.items_weighed}/${w.items_to_weigh} weighed)</span>` : ''}</div>`;
  let body = '';
  if (!w.paid_online) {
    body = `<div class="wb-line">💵 Charge <b>${money(w.actual_cents)}</b> at pickup</div>`;
  } else if (w.pending_link) {
    body = `<div class="wb-line wb-owe">Waiting for the customer to pay <b>${money(w.pending_link.amount_cents)}</b>${w.pending_link.demo ? ' (DEMO)' : ''}</div>
      <div class="wb-btns"><button type="button" class="small secondary" data-copy="${esc(w.pending_link.url)}">📋 Copy payment link</button>
      <button type="button" class="small secondary" data-settle="mark_paid" data-adj="${w.pending_link.id}" data-order="${o.id}">✓ Paid</button></div>`;
  } else if (w.outstanding_cents > 0) {
    body = `<div class="wb-line wb-owe">Customer owes <b>${amt}</b> more</div>
      <div class="wb-btns"><button type="button" class="small" data-settle="charge_link" data-order="${o.id}" data-amt="${amt}">💳 Payment link ${amt}</button>
      <button type="button" class="small secondary" data-settle="collected" data-order="${o.id}" data-amt="${amt}">Collected at pickup</button>
      <button type="button" class="small link" data-settle="waive" data-order="${o.id}" data-amt="${amt}">Waive</button></div>`;
  } else if (w.outstanding_cents < 0) {
    body = `<div class="wb-line wb-refund">Refund <b>${amt}</b> to the customer</div>
      <div class="wb-btns"><button type="button" class="small" data-settle="refund" data-order="${o.id}" data-amt="${amt}">↩ Refund ${amt}${w.can_refund_in_stripe ? '' : ''}</button>
      <button type="button" class="small secondary" data-settle="refunded_manually" data-order="${o.id}" data-amt="${amt}">Refunded in Stripe</button>
      <button type="button" class="small link" data-settle="waive" data-order="${o.id}" data-amt="${amt}">No refund</button></div>`;
  } else if (w.all_weighed || w.adjustments.length) {
    body = '<div class="wb-line wb-ok">✓ Settled</div>';
  }
  const hist = w.adjustments.filter((a) => a.status === 'done').map((a) => `<li>${{
    refund: `↩ Refunded ${money(a.amount_cents)}`, charge: `💳 Paid ${money(a.amount_cents)} by link`,
    collected: `💵 Collected ${money(a.amount_cents)}`, waive: `Waived ${money(a.amount_cents)}` }[a.kind]}${a.demo ? ' (DEMO)' : ''}</li>`).join('');
  return `<div class="weigh-bar">${head}${body}${hist ? `<ul class="wb-hist">${hist}</ul>` : ''}</div>`;
}

function ticketCard(o, { online = false } = {}) {
  const d = due(o);
  const packed = o.items.filter((i) => i.packed).length;
  const next = NEXT[o.status];
  const unseen = online && !o.seen_at;
  return `
  <article class="ticket st-${o.status} ${unseen ? 'unseen' : ''}" id="ticket-${o.id}">
    ${unseen ? '<div class="ribbon">NEW</div>' : ''}
    <header>
      ${num(o, 'big')}
      <div class="who">
        <a href="#customer/${o.customer_id}" class="name">${esc(o.customer_name)}</a>
        ${o.customer_phone ? `<a class="muted" href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a>` : ''}
      </div>
      <div class="due ${d.cls}">${esc(d.text)} ${paid(o)}${orderRefTxt(o) ? ` <span class="order-ref">${orderRefTxt(o)}</span>` : ''}</div>
    </header>
    ${online ? `<div class="muted small-meta">Ordered ${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${badge(o.status)}</div>` : ''}
    <ul class="checklist">${o.items.map((it) => itemLine(it, { checkable: !online })).join('')}</ul>
    ${o.notes ? `<p class="t-notes">📝 ${esc(o.notes)}</p>` : ''}
    ${o.delivery_address ? `<p class="t-notes">🚚 ${esc(o.delivery_address)}</p>` : ''}
    ${online ? '' : weighBar(o)}
    <footer>
      ${online
        ? `<span class="muted">${o.items.length} item${o.items.length === 1 ? '' : 's'} · ${money(o.total_cents)}</span>`
        : `<span class="progress" title="Items packed"><span style="width:${o.items.length ? (packed / o.items.length) * 100 : 0}%"></span></span><span class="muted">${packed}/${o.items.length} packed</span>`}
      <span class="spacer"></span>
      <button type="button" class="secondary small" data-print="${o.id}" title="Print ticket">🖨</button>
      ${unseen ? `<button type="button" class="small" data-seen="${o.id}">Got it</button>` : ''}
      ${!online && next ? `<button type="button" class="small" data-advance="${o.id}" data-to="${next.status}">${next.label}</button>` : ''}
    </footer>
  </article>`;
}

async function loadBoard() {
  boardOrders = await api('/api/admin/board');
  renderBoard();
}
function renderBoard() {
  const q = $('#board-search').value.trim().toLowerCase();
  const shown = boardOrders.filter((o) => !q || [String(o.id), String(o.slot_number)].includes(q.replace('#', ''))
    || o.customer_name.toLowerCase().includes(q));
  for (const col of document.querySelectorAll('.board-col')) {
    const list = shown.filter((o) => o.status === col.dataset.status);
    col.querySelector('.col-count').textContent = list.length || '';
    // A small heading whenever the pickup day or half-hour slot changes.
    let last = null;
    col.querySelector('.col-body').innerHTML = list.length ? list.map((o) => {
      const key = `${o.pickup_date || ''}|${slotStart(o.pickup_time) || ''}`;
      const head = key !== last ? `<div class="slot-divider ${due(o).cls}">${esc(o.pickup_date ? due({ ...o, pickup_time: null }).text.replace(/^(Pickup|Deliver) /, '') : 'No pickup date')}${o.pickup_time ? ` · ${esc(slotLabel(slotStart(o.pickup_time)))}${slotRange(slotStart(o.pickup_time)) ? ` · ${slotRange(slotStart(o.pickup_time))}` : ''}` : ''}</div>` : '';
      last = key;
      return head + ticketCard(o);
    }).join('') : '<p class="muted col-empty">Nothing here</p>';
  }
}
$('#board-search').addEventListener('input', renderBoard);
$('#board-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
});

document.addEventListener('change', async (e) => {
  if (!e.target.matches('input[data-item]')) return;
  const box = e.target;
  box.closest('li, tr')?.classList.toggle('packed', box.checked);
  try {
    const o = await api(`/api/admin/items/${box.dataset.item}`, jsonOpts('PATCH', { packed: box.checked }));
    const i = boardOrders.findIndex((x) => x.id === o.id);
    if (i >= 0) { boardOrders[i] = o; renderBoard(); }
    const j = browseOrders.findIndex((x) => x.id === o.id);
    if (j >= 0) { browseOrders[j] = o; renderBrowse(); }
  } catch (err) {
    box.checked = !box.checked;
    if (!(err instanceof AuthError)) alert(`Could not save: ${err.message}`);
  }
});

document.addEventListener('click', async (e) => {
  const adv = e.target.closest('[data-advance]');
  if (adv) {
    const o = boardOrders.find((x) => String(x.id) === adv.dataset.advance);
    const unpacked = o ? o.items.filter((i) => !i.packed).length : 0;
    if (adv.dataset.to === 'ready' && unpacked && !confirm(`${unpacked} item(s) on order ${pickupNo(o || { id: adv.dataset.advance })} aren't ticked yet. Mark it ready anyway?`)) return;
    adv.disabled = true;
    try {
      await api(`/api/admin/orders/${adv.dataset.advance}`, jsonOpts('PATCH', { status: adv.dataset.to }));
      await loadBoard();
      refreshCounts();
    } catch (err) { if (!(err instanceof AuthError)) alert(err.message); adv.disabled = false; }
  }
  const seen = e.target.closest('[data-seen]');
  if (seen) {
    await api(`/api/admin/orders/${seen.dataset.seen}/seen`, { method: 'POST' }).catch(() => {});
    refreshCounts(); loadOnline().catch(() => {});
  }
  const pr = e.target.closest('[data-print]');
  if (pr) printTicket(pr.dataset.print);
});

// ================= Online orders =================
async function loadStripeStatus() {
  const st = await api('/api/admin/stripe');
  const box = $('#stripe-status');
  if (!st.enabled && st.demo) {
    box.className = 'stripe-status demo';
    box.innerHTML = `<b>💳 Stripe demo mode</b> — no real Stripe account is connected yet. To see fake <b>paid</b> orders arrive,
      double-click <code>demo-stripe-orders.bat</code> in the program folder. Paid orders marked "DEMO" are fake.
      Add a real Stripe key to the <code>.env</code> file to go live.`;
    return;
  }
  if (!st.enabled) {
    box.className = 'stripe-status off';
    box.innerHTML = `<b>Stripe not connected.</b> Paid Stripe orders can flow in here automatically — add your Stripe key to the <code>.env</code> file (see the README, "Connecting Stripe").`;
    return;
  }
  const ago = st.lastSyncAt ? `last checked ${new Date(st.lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'checking…';
  box.className = `stripe-status ${st.lastError ? 'err' : 'on'}`;
  box.innerHTML = st.lastError
    ? `<b>Stripe problem:</b> ${esc(st.lastError)} <button type="button" class="link" id="stripe-sync">Try again</button>`
    : `<b>💳 Stripe connected</b> — paid orders appear here ${st.webhook ? 'instantly' : 'within a minute'} · ${ago}
       <button type="button" class="link" id="stripe-sync">Check Stripe now</button>`;
}
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'stripe-sync') return;
  e.target.textContent = 'Checking…';
  e.target.disabled = true;
  try {
    const r = await api('/api/admin/stripe/sync', { method: 'POST' });
    if (!r.added) e.target.textContent = 'No new orders';
  } catch (err) { if (!(err instanceof AuthError)) console.warn(err); }
  setTimeout(() => loadStripeStatus().catch(() => {}), 1200);
});

async function loadOnline() {
  loadStripeStatus().catch(() => {});
  const list = await api(`/api/admin/online?show=${$('#online-show').value}`);
  $('#online-empty').classList.toggle('hidden', list.length > 0);
  $('#online-list').innerHTML = list.map((o) => ticketCard(o, { online: true })).join('');
}
$('#online-show').addEventListener('change', () => loadOnline().catch(() => {}));
$('#online-seen-all').addEventListener('click', async () => {
  await api('/api/admin/online/seen-all', { method: 'POST' }).catch(() => {});
  refreshCounts(); loadOnline().catch(() => {});
});
const orderPage = `${location.origin}/`;
$('#order-link').href = orderPage;
$('#order-link').textContent = orderPage;
$('#copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(orderPage); $('#copy-link').textContent = 'Copied ✓'; }
  catch { prompt('Copy this link:', orderPage); }
  setTimeout(() => { $('#copy-link').textContent = 'Copy link'; }, 2000);
});

// ================= Weighing =================
function updateOrderEverywhere(o) {
  const i = boardOrders.findIndex((x) => x.id === o.id);
  if (i >= 0) { boardOrders[i] = o; renderBoard(); }
  const j = browseOrders.findIndex((x) => x.id === o.id);
  if (j >= 0) { browseOrders[j] = o; renderBrowse(); }
  if (location.hash.startsWith('#customer/')) route({ quiet: true });
}
document.addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-weigh]');
  if (!input) return;
  input.disabled = true;
  try {
    const o = await api(`/api/admin/items/${input.dataset.weigh}/weight`, jsonOpts('PATCH', { actual: input.value === '' ? null : Number(input.value) }));
    updateOrderEverywhere(o);
  } catch (err) { if (!(err instanceof AuthError)) alert(`Could not save the weight: ${err.message}`); input.disabled = false; }
});
document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = '✓ Copied — text or email it'; }
    catch { prompt('Copy this payment link and send it to the customer:', copy.dataset.copy); }
    return;
  }
  const b = e.target.closest('[data-settle]');
  if (!b) return;
  const action = b.dataset.settle;
  const ask = {
    refund: `Refund ${b.dataset.amt} to the customer's card through Stripe?`,
    charge_link: `Create a Stripe payment link for ${b.dataset.amt}? You can then copy it and send it to the customer.`,
    collected: `Mark ${b.dataset.amt} as collected at pickup?`,
    waive: `Waive ${b.dataset.amt}? Nothing will be charged or refunded.`,
    refunded_manually: `Did you already refund ${b.dataset.amt} in Stripe or the shop dashboard?`,
    mark_paid: 'Has the customer paid the extra amount?',
  }[action];
  if (ask && !confirm(ask)) return;
  b.disabled = true;
  try {
    const o = await api(`/api/admin/orders/${b.dataset.order}/settle`, jsonOpts('POST', { action, adjustment_id: b.dataset.adj }));
    updateOrderEverywhere(o);
    if (action === 'charge_link' && o.weigh.pending_link) {
      try { await navigator.clipboard.writeText(o.weigh.pending_link.url); } catch { /* shown below */ }
      prompt('Payment link created (copied). Send it to the customer by text or email:', o.weigh.pending_link.url);
    }
  } catch (err) { if (!(err instanceof AuthError)) alert(err.message); b.disabled = false; }
});

// ================= Printing tickets =================
async function printTicket(id) {
  let o;
  try { o = await api(`/api/admin/orders/${id}`); } catch (err) { if (!(err instanceof AuthError)) alert(err.message); return; }
  const d = due(o);
  $('#print-area').innerHTML = `
    <div class="pt">
      <div class="pt-top">
        <div class="pt-num"><small>${o.slot_number != null ? 'PICKUP #' : 'ORDER'}</small>${pickupNo(o)}</div>
        <div class="pt-who">
          <div class="pt-name">${esc(o.customer_name)}</div>
          ${o.customer_phone ? `<div>${esc(o.customer_phone)}</div>` : ''}
          <div class="pt-due">${esc(d.text)}</div>
          ${o.payment_status === 'paid' ? '<div class="pt-paid">PAID ONLINE</div>' : ''}
        </div>
      </div>
      <table class="pt-items">
        <thead><tr><th></th><th>Qty</th><th>Item</th><th>Cut / instructions</th><th>Actual</th></tr></thead>
        <tbody>${o.items.map((it) => `<tr><td class="pt-box">☐</td><td class="pt-q">${esc(qty(it))}</td><td>${esc(it.product_name)}</td><td>${esc(it.cut_instructions || '')}</td>
          <td class="pt-actual">${it.unit === 'lb' ? (it.actual_quantity != null ? `<b>${it.actual_quantity} lb</b>` : '______ lb') : ''}</td></tr>`).join('')}</tbody>
      </table>
      ${o.notes ? `<p><b>Notes:</b> ${esc(o.notes)}</p>` : ''}
      ${o.delivery_address ? `<p><b>Deliver to:</b> ${esc(o.delivery_address)}</p>` : ''}
      <div class="pt-foot">
        <span>${o.items.length} item${o.items.length === 1 ? '' : 's'} · ${o.payment_status === 'paid' ? 'paid' : 'est.'} ${money(o.total_cents)}${o.weigh?.items_weighed ? ` · weighed ${money(o.weigh.actual_cents)}` : ''}</span>
        <span>${o.slot_number != null ? `Order ${o.id} · ` : ''}Ordered ${when(o.created_at)}</span>
      </div>
    </div>`;
  window.print();
}

// ================= Live updates & alerts =================
let live = null;
let fallbackTimer = null;

async function refreshCounts() {
  try {
    const c = await api('/api/admin/counts');
    $('#count-online').textContent = c.unseen_online || '';
    $('#count-open').textContent = c.open_orders || '';
    document.title = `${c.unseen_online ? `(${c.unseen_online}) ` : ''}Orders — Butcher Shop`;
  } catch { /* offline / logged out */ }
}

function refreshVisible() {
  const busy = document.activeElement?.matches('input:not([type=checkbox]):not([type=search]), select, textarea');
  const h = location.hash.slice(1);
  if (busy || h.startsWith('new') || h === 'import') return;
  route({ quiet: true });
}

function startLive() {
  if (live || !window.EventSource) return;
  live = new EventSource('/api/admin/events');
  let timer;
  live.addEventListener('change', (e) => {
    const evt = JSON.parse(e.data || '{}');
    if (evt.type === 'online-order') announce(evt);
    refreshCounts();
    clearTimeout(timer);
    timer = setTimeout(refreshVisible, 250);   // several quick changes → one refresh
  });
  // Safety net in case the live connection drops unnoticed.
  fallbackTimer = setInterval(() => { refreshCounts(); if (!document.hidden) refreshVisible(); }, 120000);
}
function stopLive() {
  live?.close(); live = null;
  clearInterval(fallbackTimer);
}

// Sound + notification for new online orders. Browsers only allow sound after a click, hence the button.
let audioCtx = null;
const alertsOn = () => { try { return localStorage.getItem('order-alerts') === 'on'; } catch { return false; } };
function updateAlertsButton() {
  const on = alertsOn() && audioCtx;
  $('#alerts').classList.toggle('hidden', !!on);
  $('#alerts').textContent = alertsOn() ? '🔔 Click to re-enable sound' : '🔔 Turn on order alerts';
}
$('#alerts').addEventListener('click', async () => {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume().catch(() => {});
  if (window.Notification && Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
  try { localStorage.setItem('order-alerts', 'on'); } catch { /* ignore */ }
  chime();
  updateAlertsButton();
});
// After the first click anywhere, sound can play again on this page load.
document.addEventListener('click', () => {
  if (alertsOn() && !audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    updateAlertsButton();
  }
}, { once: false, capture: true });

function chime() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [[880, 0], [1320, 0.18], [1760, 0.36]].forEach(([f, at]) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.3, t + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.35);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + at); o.stop(t + at + 0.4);
  });
}

let toastTimer;
function announce(evt) {
  if (alertsOn()) chime();
  const no = evt.slot_number != null ? `#${evt.slot_number}${evt.pickup_date ? ` (${day(evt.pickup_date)})` : ''}` : `#${evt.id}`;
  const text = `New online order ${no} from ${evt.name} · ${money(evt.total_cents)}`;
  const t = $('#toast');
  t.innerHTML = `<b>🛒 ${esc(text)}</b><a href="#online">View</a>`;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 15000);
  if (alertsOn() && window.Notification && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification('New online order', { body: text, icon: '/icons/admin-icon-192.png', tag: `order-${evt.id}` });
    n.onclick = () => { window.focus(); location.hash = 'online'; n.close(); };
  }
}
$('#toast').addEventListener('click', () => $('#toast').classList.add('hidden'));

// ================= Start =================
fetch('/api/admin/session').then(async (r) => {
  if (!r.ok) return showLogin();
  const s = await r.json().catch(() => ({}));
  showApp();
  if (s.login === false) $('#logout').classList.add('hidden');   // no password set: nothing to log out of
  route();
}).catch(() => {
  $('#view-login').classList.remove('hidden');
  showError($('#login-error'), 'Could not reach the server. Is the program running?');
});
