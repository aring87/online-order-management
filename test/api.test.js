'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

const AUTH = { Authorization: 'Basic ' + Buffer.from('admin:secret').toString('base64') };

async function withServer(fn) {
  const db = openDb(':memory:');
  const server = createApp(db, { adminPassword: 'secret' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  try { await fn(req); } finally { server.close(); }
}

const order = (overrides = {}) => ({
  name: 'Jane Doe', email: 'jane@example.com', phone: '555-0100',
  pickup_date: '2026-12-01',
  items: [{ product_id: 1, quantity: 2, cut_instructions: '1.5" thick' }, { product_id: 4, quantity: 3 }],
  ...overrides,
});

test('places an order and groups orders by customer', () => withServer(async (req) => {
  const { data: products } = await req('/api/products');
  assert.ok(products.length > 0);

  const r1 = await req('/api/orders', { method: 'POST', body: order() });
  assert.equal(r1.status, 201);
  assert.equal(r1.data.items.length, 2);
  const p1 = products.find((p) => p.id === 1);
  const p4 = products.find((p) => p.id === 4);
  assert.equal(r1.data.total_cents, 2 * p1.price_cents + 3 * p4.price_cents);
  assert.equal(r1.data.items[0].cut_instructions, '1.5" thick');

  // Same email (different case) → same customer
  const r2 = await req('/api/orders', { method: 'POST', body: order({ email: 'JANE@example.com', items: [{ product_id: 2, quantity: 1 }] }) });
  assert.equal(r2.status, 201);
  await req('/api/orders', { method: 'POST', body: order({ name: 'Bob', email: 'bob@example.com' }) });

  const { data: customers } = await req('/api/admin/customers', { headers: AUTH });
  assert.equal(customers.length, 2);
  const jane = customers.find((c) => c.email === 'jane@example.com');
  assert.equal(jane.order_count, 2);

  const { data: detail } = await req(`/api/admin/customers/${jane.id}`, { headers: AUTH });
  assert.equal(detail.orders.length, 2);
  assert.equal(detail.orders[0].id, r2.data.id, 'newest order first');
  assert.equal(detail.orders[1].items.length, 2);

  const { data: search } = await req('/api/admin/customers?q=bob', { headers: AUTH });
  assert.deepEqual(search.map((c) => c.name), ['Bob']);
}));

test('updates order status', () => withServer(async (req) => {
  const { data: o } = await req('/api/orders', { method: 'POST', body: order() });
  const r = await req(`/api/admin/orders/${o.id}`, { method: 'PATCH', body: { status: 'ready' }, headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ready');
  const bad = await req(`/api/admin/orders/${o.id}`, { method: 'PATCH', body: { status: 'eaten' }, headers: AUTH });
  assert.equal(bad.status, 400);
  const { data: ready } = await req('/api/admin/orders?status=ready', { headers: AUTH });
  assert.equal(ready.length, 1);
}));

test('rejects invalid orders', () => withServer(async (req) => {
  const cases = [
    order({ name: '' }),
    order({ email: 'nope' }),
    order({ items: [] }),
    order({ items: [{ product_id: 9999, quantity: 1 }] }),
    order({ items: [{ product_id: 1, quantity: -1 }] }),
    order({ fulfillment: 'delivery', delivery_address: '' }),
  ];
  for (const body of cases) {
    const r = await req('/api/orders', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.data.error);
  }
  const { data: customers } = await req('/api/admin/customers', { headers: AUTH });
  assert.equal(customers.length, 0, 'nothing saved on failure');
}));

test('admin endpoints require the password', () => withServer(async (req) => {
  assert.equal((await req('/api/admin/customers')).status, 401);
  assert.equal((await req('/admin')).status, 401);
  const wrong = { Authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') };
  assert.equal((await req('/api/admin/customers', { headers: wrong })).status, 401);
  assert.equal((await req('/admin', { headers: AUTH })).status, 200);
  assert.equal((await req('/admin.html')).status, 404, 'admin page not exposed statically');
}));
