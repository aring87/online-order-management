'use strict';

const $ = (sel) => document.querySelector(sel);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let products = [];

async function loadProducts() {
  const res = await fetch('/api/products');
  products = await res.json();
  const byCat = {};
  for (const p of products) (byCat[p.category] ||= []).push(p);

  $('#products').innerHTML = Object.entries(byCat).map(([cat, list]) => `
    <h3>${esc(cat)}</h3>
    ${list.map((p) => `
      <div class="product-row" data-id="${p.id}">
        <div>
          <div class="name">${esc(p.name)}</div>
          <div class="price">${money(p.price_cents)} / ${p.unit}</div>
        </div>
        <div>
          <input class="qty" type="number" inputmode="${p.unit === 'lb' ? 'decimal' : 'numeric'}" min="0" step="${p.unit === 'lb' ? '0.25' : '1'}" placeholder="${p.unit === 'lb' ? 'lbs' : 'qty'}" aria-label="Quantity of ${esc(p.name)} (${p.unit})">
        </div>
        <div class="cut"><input class="cut-in" placeholder="Cut instructions (optional)" aria-label="Cut instructions for ${esc(p.name)}" maxlength="300"></div>
      </div>`).join('')}
  `).join('');
}

function selectedItems() {
  return [...document.querySelectorAll('.product-row')]
    .map((row) => ({
      product: products.find((p) => p.id === Number(row.dataset.id)),
      quantity: Number(row.querySelector('.qty').value),
      cut_instructions: row.querySelector('.cut-in').value.trim(),
    }))
    .filter((it) => it.quantity > 0);
}

function updateTotal() {
  const items = selectedItems();
  const total = items.reduce((s, it) => s + Math.round(it.quantity * it.product.price_cents), 0);
  $('#total').textContent = money(total);
  $('#item-count').textContent = items.length;
}

function showError(msg) {
  $('#error').textContent = msg;
  $('#error').classList.toggle('hidden', !msg);
}

$('#products').addEventListener('input', updateTotal);

$('#fulfillment').addEventListener('change', (e) => {
  const delivery = e.target.value === 'delivery';
  $('#address-field').classList.toggle('hidden', !delivery);
  $('#date-label').textContent = delivery ? 'Delivery date' : 'Pickup date';
});

$('#order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const items = selectedItems();
  if (!items.length) return showError('Please enter a quantity for at least one item.');
  if (closedDay) return showError(closedDay);

  const f = e.target;
  const payload = {
    name: $('#name').value,
    email: $('#email').value,
    phone: $('#phone').value,
    fulfillment: $('#fulfillment').value,
    pickup_date: $('#pickup_date').value,
    pickup_time: $('#pickup_time').value,
    delivery_address: $('#delivery_address').value,
    notes: $('#notes').value,
    items: items.map((it) => ({ product_id: it.product.id, quantity: it.quantity, cut_instructions: it.cut_instructions })),
  };

  $('#submit').disabled = true;
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) { refreshSlots(); return showError(data.error || 'Could not place order.'); }
    // Pickup number (by time slot) when there is one, otherwise the order number.
    $('#done-number').textContent = data.slot_number ?? data.id;
    $('#done-number-label').textContent = data.slot_number != null ? 'Your pickup number' : 'Your order number';
    $('#done-msg').textContent = `${data.items.length} item(s) · estimated ${money(data.total_cents)}. We'll contact you at ${payload.email} if we have any questions.`;
    saveDetails();
    f.classList.add('hidden');
    $('#done').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch {
    showError('Network error — please try again.');
  } finally {
    $('#submit').disabled = false;
  }
});

$('#another').addEventListener('click', () => {
  $('#order-form').reset();
  document.querySelectorAll('.qty, .cut-in').forEach((i) => { i.value = ''; });
  restoreDetails();
  $('#address-field').classList.add('hidden');
  updateTotal();
  $('#done').classList.add('hidden');
  $('#order-form').classList.remove('hidden');
});

// Remember contact details on this device so repeat orders are quick.
const DETAILS_KEY = 'butcher-details';
const DETAIL_FIELDS = ['name', 'email', 'phone', 'delivery_address'];
function saveDetails() {
  try {
    if ($('#remember').checked) {
      localStorage.setItem(DETAILS_KEY, JSON.stringify(Object.fromEntries(DETAIL_FIELDS.map((k) => [k, $(`#${k}`).value]))));
    } else {
      localStorage.removeItem(DETAILS_KEY);
    }
  } catch { /* storage unavailable */ }
}
function restoreDetails() {
  try {
    const saved = JSON.parse(localStorage.getItem(DETAILS_KEY) || 'null');
    if (saved) for (const k of DETAIL_FIELDS) if (saved[k]) $(`#${k}`).value = saved[k];
  } catch { /* storage unavailable */ }
}

const today = new Date();
$('#pickup_date').min = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Half-hour pickup slots within opening hours (set in the program's .env file).
function slotOptions({ open = '10:00', close = '18:00', slot_minutes: step = 30 } = {}) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const nice = (m) => new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const out = [];
  for (let m = toMin(open); m + step <= toMin(close); m += step) out.push(`<option value="${hhmm(m)}">${nice(m)} – ${nice(m + step)}</option>`);
  return out.join('');
}
fetch('/api/settings').then((r) => r.json()).then((s) => { $('#pickup_time').innerHTML += slotOptions(s.pickup); })
  .catch(() => { $('#pickup_time').innerHTML += slotOptions(); });

// Once a date is picked, show how many places are left in each slot; full slots can't be chosen.
let closedDay = '';
async function refreshSlots() {
  const date = $('#pickup_date').value;
  if (!date) return;
  let data;
  try { data = await (await fetch(`/api/slots?date=${date}`)).json(); } catch { return; }
  if (!data.slots) return;
  // Closed days (e.g. Mondays) can't be chosen; other days list only that day's slots (Sundays until 3 PM).
  closedDay = data.closed ? `Sorry, we're closed on ${data.day}s. Please choose another day.` : '';
  $('#date-note').textContent = closedDay;
  $('#date-note').classList.toggle('hidden', !closedDay);
  $('#pickup_time').disabled = Boolean(closedDay);
  const nice = (t) => new Date(2000, 0, 1, Number(t.slice(0, 2)), Number(t.slice(3, 5))).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const chosen = $('#pickup_time').value;
  $('#pickup_time').innerHTML = '<option value="">Any time</option>' + data.slots.map((s) => {
    const left = s.max ? s.max - s.count : null;
    const note = s.full ? ' — FULL' : left !== null && left <= 3 ? ` — only ${left} left` : '';
    return `<option value="${s.start}" ${s.full ? 'disabled' : ''}>${nice(s.start)} – ${nice(s.end)}${note}</option>`;
  }).join('');
  const still = [...$('#pickup_time').options].find((o) => o.value === chosen && !o.disabled);
  $('#pickup_time').value = still ? chosen : '';
}
$('#pickup_date').addEventListener('change', refreshSlots);

restoreDetails();
loadProducts().catch(() => {
  $('#products').textContent = navigator.onLine === false
    ? "You're offline. Connect to the internet to see today's cuts and place an order."
    : 'Could not load products. Please refresh.';
});
