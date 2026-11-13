'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { verifySignature, parseTime, pickupDate, sessionToOrder } = require('../src/stripe');

const KEY = 'rk_test_123';
const WHSEC = 'whsec_test_abc';
const now = Math.floor(Date.now() / 1000);

const paidSession = (id = 'cs_test_1', extra = {}) => ({
  id, object: 'checkout.session', status: 'complete', payment_status: 'paid', created: now - 60, payment_intent: `pi_${id}`,
  customer_details: { name: 'Jane Buyer', email: 'jane@example.com', phone: '+1 555 201 0000' },
  custom_fields: [
    { key: 'pickupdate', label: { type: 'custom', custom: 'Pickup date' }, type: 'text', text: { value: '12/24/2026' } },
    { key: 'pickuptime', label: { type: 'custom', custom: 'Pickup time' }, type: 'dropdown',
      dropdown: { value: '3pm', options: [{ label: '3:00 PM', value: '3pm' }] } },
    { key: 'cuts', label: { type: 'custom', custom: 'Cutting instructions' }, type: 'text', text: { value: 'Ribeyes 1.5 inch' } },
  ],
  metadata: {},
  ...extra,
});
const LINE_ITEMS = [
  { id: 'li_1', description: 'Ribeye Steak (per lb)', quantity: 3, amount_total: 7497,
    price: { unit_amount: 2499, product: { name: 'Ribeye Steak (per lb)', metadata: {} } } },
  { id: 'li_2', description: 'Whole Chicken', quantity: 2, amount_total: 2998,
    price: { unit_amount: 1499, product: { name: 'Whole Chicken', metadata: { cut_instructions: 'spatchcock' } } } },
];

// A stand-in for api.stripe.com.
async function mockStripe(sessions) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'Invalid API Key provided' } }));
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/v1/checkout/sessions') return res.end(JSON.stringify({ object: 'list', data: sessions, has_more: false }));
    const m = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/);
    if (m) return res.end(JSON.stringify({ object: 'list', data: LINE_ITEMS, has_more: false }));
    res.statusCode = 404; res.end('{}');
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

async function withServer(stripeOpts, fn) {
  const db = openDb(':memory:');
  const app = createApp(db, { adminPassword: 'secret', stripe: stripeOpts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'secret' }),
  });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + p, { method, headers: { Cookie, 'Content-Type': 'application/json', ...headers }, body });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  req.base = base;
  try { await fn(req, app); } finally { server.closeAllConnections(); server.close(); }
}

const sign = (payload, secret = WHSEC, t = now) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

test('paid Stripe checkouts are pulled in as unread online orders', async () => {
  const stripe = await mockStripe([
    paidSession('cs_test_1'),
    paidSession('cs_test_unpaid', { payment_status: 'unpaid' }),
  ]);
  try {
    await withServer({ secretKey: KEY, apiBase: stripe.base }, async (req) => {
      const r = await req('/api/admin/stripe/sync', { method: 'POST' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.added, 1, 'unpaid checkout skipped');

      const { data: online } = await req('/api/admin/online');
      assert.equal(online.length, 1);
      const o = online[0];
      assert.equal(o.customer_name, 'Jane Buyer');
      assert.equal(o.customer_email, 'jane@example.com');
      assert.equal(o.payment_status, 'paid');
      assert.equal(o.order_ref, 'pi_cs_test_1');
      assert.equal(o.pickup_date, '2026-12-24');
      assert.equal(o.pickup_time, '15:00');
      assert.match(o.notes, /Cutting instructions: Ribeyes 1.5 inch/);
      assert.equal(o.seen_at, null);
      assert.equal(o.total_cents, 7497 + 2998);
      assert.deepEqual(o.items.map((i) => [i.product_name, i.quantity, i.unit]), [['Ribeye Steak (per lb)', 3, 'lb'], ['Whole Chicken', 2, 'each']]);
      assert.equal(o.items[1].cut_instructions, 'spatchcock');

      const again = await req('/api/admin/stripe/sync', { method: 'POST' });
      assert.equal(again.data.added, 0, 'never added twice');
      const { data: status } = await req('/api/admin/stripe');
      assert.equal(status.enabled, true);
      assert.ok(status.lastSyncAt);
      assert.ok(stripe.calls.some((c) => c.includes('status=complete')));
    });
  } finally { stripe.close(); }
});

test('Stripe webhook adds the order instantly, verifies signatures, and never duplicates', async () => {
  const stripe = await mockStripe([paidSession('cs_test_2')]);
  try {
    await withServer({ secretKey: KEY, webhookSecret: WHSEC, apiBase: stripe.base }, async (req) => {
      const event = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: paidSession('cs_test_2') } });
      const post = (body, sig) => fetch(req.base + '/api/stripe/webhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body,
      });

      assert.equal((await post(event, sign(event, 'whsec_wrong'))).status, 400, 'forged webhook rejected');
      assert.equal((await post(event, sign(event, WHSEC, now - 3600))).status, 400, 'old replayed webhook rejected');
      let { data: online } = await req('/api/admin/online');
      assert.equal(online.length, 0);

      assert.equal((await post(event, sign(event))).status, 200);
      ({ data: online } = await req('/api/admin/online'));
      assert.equal(online.length, 1);
      assert.equal(online[0].items.length, 2);

      assert.equal((await post(event, sign(event))).status, 200, 'Stripe retries are fine');
      const sync = await req('/api/admin/stripe/sync', { method: 'POST' });
      assert.equal(sync.data.added, 0, 'polling skips orders the webhook already added');
      ({ data: online } = await req('/api/admin/online'));
      assert.equal(online.length, 1);

      const other = JSON.stringify({ type: 'customer.created', data: { object: {} } });
      assert.equal((await post(other, sign(other))).status, 200, 'other events are acknowledged and ignored');
    });
  } finally { stripe.close(); }
});

test('a wrong Stripe key gives a clear message', async () => {
  const stripe = await mockStripe([]);
  try {
    await withServer({ secretKey: 'rk_test_wrong', apiBase: stripe.base }, async (req) => {
      const r = await req('/api/admin/stripe/sync', { method: 'POST' });
      assert.equal(r.status, 502);
      assert.match(r.data.error, /STRIPE_SECRET_KEY/);
    });
  } finally { stripe.close(); }
});

test('without a Stripe key the program works and says how to connect', () => withServer({}, async (req) => {
  const { data } = await req('/api/admin/stripe');
  assert.equal(data.enabled, false);
  assert.equal((await req('/api/admin/stripe/sync', { method: 'POST' })).status, 400);
  const res = await fetch(req.base + '/api/stripe/webhook', { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
}));

test('reads pickup dates and times typed by customers', () => {
  assert.equal(parseTime('3pm'), '15:00');
  assert.equal(parseTime('3:30 PM'), '15:30');
  assert.equal(parseTime('12:15 a.m.'), '00:15');
  assert.equal(parseTime('14:45'), '14:45');
  assert.equal(parseTime('3'), null);
  assert.equal(parseTime('soon'), null);
  const year = new Date().getFullYear();
  assert.equal(pickupDate('12/24/2026'), '2026-12-24');
  assert.match(pickupDate('Dec 24'), new RegExp(`^(${year}|${year + 1})-12-24$`));

  const { order } = sessionToOrder(paidSession('cs_x', {
    custom_fields: [{ key: 'p', label: { custom: 'Pickup' }, type: 'text', text: { value: '12/20/2026 at 4:30 pm' } },
      { key: 'd', label: { custom: 'Pickup day' }, type: 'text', text: { value: 'Saturday morning' } }],
    collected_information: { shipping_details: { name: 'J', address: { line1: '1 Elm St', city: 'Springfield', state: 'IL', postal_code: '62701', country: 'US' } } },
  }), LINE_ITEMS);
  assert.equal(order.pickupDate, '2026-12-20');
  assert.equal(order.pickupTime, '16:30');
  assert.match(order.notes, /Pickup day: Saturday morning/, 'unreadable text kept as a note');
  assert.equal(order.fulfillment, 'delivery');
  assert.equal(order.deliveryAddress, '1 Elm St, Springfield, IL 62701');
});

test('signature check', () => {
  const body = '{"a":1}';
  assert.ok(verifySignature(body, sign(body), WHSEC));
  assert.ok(!verifySignature(body + ' ', sign(body), WHSEC));
  assert.ok(!verifySignature(body, 'garbage', WHSEC));
  assert.ok(!verifySignature(body, sign(body), ''));
});
