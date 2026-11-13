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
const num = (o, size = '') => `<span class="onum ${size}" title="Order number">${o.id}</span>`;
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
const VIEWS = ['board', 'online', 'customers', 'orders', 'new', 'import'];
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
    `<table class="stack gtable"><tbody>${g.list.map((o) => `<tr>
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
  </label></li>`;
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
      <div class="due ${d.cls}">${esc(d.text)} ${paid(o)}</div>
    </header>
    ${online ? `<div class="muted small-meta">Ordered ${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${badge(o.status)}</div>` : ''}
    <ul class="checklist">${o.items.map((it) => itemLine(it, { checkable: !online })).join('')}</ul>
    ${o.notes ? `<p class="t-notes">📝 ${esc(o.notes)}</p>` : ''}
    ${o.delivery_address ? `<p class="t-notes">🚚 ${esc(o.delivery_address)}</p>` : ''}
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
  const shown = boardOrders.filter((o) => !q || String(o.id) === q.replace('#', '') || o.customer_name.toLowerCase().includes(q));
  for (const col of document.querySelectorAll('.board-col')) {
    const list = shown.filter((o) => o.status === col.dataset.status);
    col.querySelector('.col-count').textContent = list.length || '';
    col.querySelector('.col-body').innerHTML = list.length ? list.map((o) => ticketCard(o)).join('') : '<p class="muted col-empty">Nothing here</p>';
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
    if (adv.dataset.to === 'ready' && unpacked && !confirm(`${unpacked} item(s) on order ${adv.dataset.advance} aren't ticked yet. Mark it ready anyway?`)) return;
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

// ================= Printing tickets =================
async function printTicket(id) {
  let o;
  try { o = await api(`/api/admin/orders/${id}`); } catch (err) { if (!(err instanceof AuthError)) alert(err.message); return; }
  const d = due(o);
  $('#print-area').innerHTML = `
    <div class="pt">
      <div class="pt-top">
        <div class="pt-num"><small>ORDER</small>${o.id}</div>
        <div class="pt-who">
          <div class="pt-name">${esc(o.customer_name)}</div>
          ${o.customer_phone ? `<div>${esc(o.customer_phone)}</div>` : ''}
          <div class="pt-due">${esc(d.text)}</div>
          ${o.payment_status === 'paid' ? '<div class="pt-paid">PAID ONLINE</div>' : ''}
        </div>
      </div>
      <table class="pt-items">
        <thead><tr><th></th><th>Qty</th><th>Item</th><th>Cut / instructions</th></tr></thead>
        <tbody>${o.items.map((it) => `<tr><td class="pt-box">☐</td><td class="pt-q">${esc(qty(it))}</td><td>${esc(it.product_name)}</td><td>${esc(it.cut_instructions || '')}</td></tr>`).join('')}</tbody>
      </table>
      ${o.notes ? `<p><b>Notes:</b> ${esc(o.notes)}</p>` : ''}
      ${o.delivery_address ? `<p><b>Deliver to:</b> ${esc(o.delivery_address)}</p>` : ''}
      <div class="pt-foot">
        <span>${o.items.length} item${o.items.length === 1 ? '' : 's'} · ${o.payment_status === 'paid' ? 'paid' : 'est.'} ${money(o.total_cents)}</span>
        <span>Ordered ${when(o.created_at)}</span>
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
  const text = `New online order #${evt.id} from ${evt.name} · ${money(evt.total_cents)}`;
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
fetch('/api/admin/session').then((r) => {
  if (r.ok) { showApp(); route(); } else showLogin();
}).catch(() => {
  $('#view-login').classList.remove('hidden');
  showError($('#login-error'), 'Could not reach the server. Is the program running?');
});
