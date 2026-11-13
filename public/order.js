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

  const f = e.target;
  const payload = {
    name: $('#name').value,
    email: $('#email').value,
    phone: $('#phone').value,
    fulfillment: $('#fulfillment').value,
    pickup_date: $('#pickup_date').value,
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
    if (!res.ok) return showError(data.error || 'Could not place order.');
    $('#done-msg').textContent = `Order #${data.id} · ${data.items.length} item(s) · estimated ${money(data.total_cents)}. We'll contact you at ${payload.email} if we have any questions.`;
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

restoreDetails();
loadProducts().catch(() => {
  $('#products').textContent = navigator.onLine === false
    ? "You're offline. Connect to the internet to see today's cuts and place an order."
    : 'Could not load products. Please refresh.';
});
