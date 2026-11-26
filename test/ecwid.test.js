'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { mapItem, mapOrder, ecwidDate } = require('../src/ecwid');

const TOKEN = 'secret_test';
const STORE = '113477012';
const now = Math.floor(Date.now() / 1000);
const local = (d) => [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`];

// An order the way Ecwid's REST API v3 returns it.
const ecwidOrder = (over = {}) => ({
  id: 'XJ12H', internalId: 555000111, orderNumber: 20417, email: 'buyer@example.com',
  paymentStatus: 'PAID', paymentModule: 'Stripe', externalTransactionId: 'pi_3Real123',
  fulfillmentStatus: 'AWAITING_PROCESSING', total: 30.27, subtotal: 29.97,
  createDate: '2026-11-26 15:04:00 +0000', createTimestamp: now - 60, updateTimestamp: now - 60,
  billingPerson: { name: 'Pat Buyer', phone: '555-010-0901' },
  shippingPerson: { name: 'Pat Buyer', phone: '555-010-0901' },
  shippingOption: { shippingMethodName: 'Pickup', fulfillmentType: 'PICKUP' },
  pickupTime: '2026-12-03 15:30:00 +0000',
  orderComments: 'Call when ready',
  items: [
    { name: 'Ground Chuck 85/15', quantity: 2, price: 11.24, selectedOptions: [
      { name: 'Amount per package', type: 'CHOICE', value: '1.5lbs', selections: [{ selectionTitle: '1.5lbs' }] },
      { name: 'Special Requests', type: 'TEXT', value: 'Frozen please' }] },
    { name: 'Whole Chicken', quantity: 1, price: 7.49, selectedOptions: [] },
  ],
  ...over,
});

test('maps Ecwid items: package size × quantity → pounds at price per lb; requests → cut', () => {
  const it = mapItem(ecwidOrder().items[0]);
  assert.deepEqual([it.unit, it.quantity, it.unitPriceCents, it.lineTotalCents], ['lb', 3, 749, 2248]);
  assert.equal(it.cut, '2 × 1.5 lb packs; Frozen please');
  const each = mapItem(ecwidOrder().items[1]);
  assert.deepEqual([each.unit, each.quantity, each.lineTotalCents], ['each', 1, 749]);
  assert.equal(mapItem({ name: 'Filet', quantity: 1, price: 8.75, selectedOptions: [{ name: 'Size', value: '8 oz' }] }).quantity, 0.5);

  const { customer, order } = mapOrder(ecwidOrder());
  assert.deepEqual(customer, { name: 'Pat Buyer', email: 'buyer@example.com', phone: '555-010-0901' });
  const [d, t] = local(ecwidDate('2026-12-03 15:30:00 +0000'));
  assert.deepEqual([order.pickupDate, order.pickupTime], [d, t], 'pickup time converted to local time');
  assert.equal(order.orderRef, 'pi_3Real123', 'Stripe payment id kept so weighing refunds can go through Stripe');
  assert.equal(order.paymentStatus, 'paid');
  assert.equal(order.id, 20417);
  assert.equal(order.notes, 'Call when ready');

  const del = mapOrder(ecwidOrder({ shippingOption: { fulfillmentType: 'DELIVERY', shippingMethodName: 'Local delivery' },
    shippingPerson: { name: 'Pat', street: '12 Maple Ave', city: 'Springfield', stateOrProvinceCode: 'VA', postalCode: '22150' },
    paymentStatus: 'AWAITING_PAYMENT', externalTransactionId: '' })).order;
  assert.equal(del.fulfillment, 'delivery');
  assert.equal(del.deliveryAddress, '12 Maple Ave, Springfield, VA 22150');
  assert.equal(del.paymentStatus, null);
  assert.equal(del.orderRef, 'Ecwid 20417');
});

async function mockEcwid(orders) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 403; return res.end('{"errorMessage":"forbidden"}'); }
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== `/api/v3/${STORE}/orders`) { res.statusCode = 404; return res.end('{}'); }
    const offset = Number(u.searchParams.get('offset') || 0);
    const page = orders.slice(offset, offset + 100);
    res.end(JSON.stringify({ total: orders.length, count: page.length, offset, limit: 100, items: page }));
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

async function withServer(ecwid, fn) {
  const db = openDb(':memory:');
  const server = createApp(db, { adminPassword: null, ecwid }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try { await fn(req, db); } finally { server.closeAllConnections(); server.close(); }
}

test('Ecwid store orders are pulled in, updated when paid/cancelled, and never duplicated', async () => {
  const orders = [
    ecwidOrder(),
    ecwidOrder({ id: 'AB34C', orderNumber: 20418, paymentStatus: 'AWAITING_PAYMENT', email: 'cash@example.com',
      billingPerson: { name: 'Cash Customer', phone: '555-010-0902' }, externalTransactionId: '' }),
    ecwidOrder({ id: 'ZZ99Z', orderNumber: 20419, paymentStatus: 'INCOMPLETE', email: 'abandoned@example.com' }),
  ];
  const ecwid = await mockEcwid(orders);
  try {
    await withServer({ storeId: STORE, token: TOKEN, apiBase: ecwid.base }, async (req) => {
      let r = await req('/api/admin/ecwid/sync', { method: 'POST' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.deepEqual([r.data.added, r.data.updated], [2, 0], 'abandoned checkout skipped');
      assert.ok(ecwid.calls[0].includes('updatedFrom='));

      const { data: online } = await req('/api/admin/online');
      const o = online.find((x) => x.customer_name === 'Pat Buyer');
      assert.equal(o.id, 20417, "Ecwid's order number kept");
      assert.equal(o.payment_status, 'paid');
      assert.equal(o.weigh.can_refund_in_stripe, true);
      assert.equal(o.items[0].quantity, 3);
      assert.equal(o.items[0].cut_instructions, '2 × 1.5 lb packs; Frozen please');
      assert.equal(o.seen_at, null, 'arrives unread');
      assert.ok(o.slot_number == null || o.slot_number > 0);

      // Customer pays the pay-at-pickup order online later; another order is cancelled in Ecwid.
      orders[1] = { ...orders[1], paymentStatus: 'PAID', updateTimestamp: now };
      orders[0] = { ...orders[0], paymentStatus: 'CANCELLED', updateTimestamp: now };
      r = await req('/api/admin/ecwid/sync', { method: 'POST' });
      assert.deepEqual([r.data.added, r.data.updated], [0, 2]);
      const { data: all } = await req('/api/admin/orders/browse?show=all');
      assert.equal(all.find((x) => x.id === 20418).payment_status, 'paid');
      assert.equal(all.find((x) => x.id === 20417).status, 'cancelled');
      assert.equal(all.length, 2);

      const { data: st } = await req('/api/admin/ecwid');
      assert.equal(st.enabled, true);
      assert.equal(st.store_id, STORE);
    });
  } finally { ecwid.close(); }
});

test('a wrong Ecwid token gives a clear message; not configured = 400', async () => {
  const ecwid = await mockEcwid([]);
  try {
    await withServer({ storeId: STORE, token: 'secret_wrong', apiBase: ecwid.base }, async (req) => {
      const r = await req('/api/admin/ecwid/sync', { method: 'POST' });
      assert.equal(r.status, 502);
      assert.match(r.data.error, /ECWID_TOKEN/);
    });
  } finally { ecwid.close(); }
  await withServer({}, async (req) => {
    assert.equal((await req('/api/admin/ecwid/sync', { method: 'POST' })).status, 400);
    assert.deepEqual((await req('/api/admin/ecwid')).data.enabled, false);
  });
});

test('Ecwid demo mode reads fake orders from the demo file through the same code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecwid-demo-'));
  const file = path.join(dir, 'ecwid-demo-orders.json');
  fs.writeFileSync(file, JSON.stringify([ecwidOrder({ id: 'DEMO1', orderNumber: 20001, orderComments: 'DEMO order' })]));
  await withServer({ demoFile: file }, async (req) => {
    const { data: st } = await req('/api/admin/ecwid');
    assert.equal(st.demo, true);
    const r = await req('/api/admin/ecwid/sync', { method: 'POST' });
    assert.equal(r.data.added, 1);
    const { data: online } = await req('/api/admin/online');
    assert.equal(online[0].id, 20001);
    assert.match(online[0].notes, /DEMO/);
    assert.equal((await req('/api/admin/ecwid/sync', { method: 'POST' })).data.added, 0, 'not added twice');
  });
});
