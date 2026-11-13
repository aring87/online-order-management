'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

async function withServer(fn) {
  const db = openDb(':memory:');
  const server = createApp(db, { adminPassword: 'secret' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'secret' }),
  });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (p, { method = 'GET', body, auth = true } = {}) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie } : {}) }, body: body && JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  req.base = base; req.Cookie = Cookie;
  try { await fn(req); } finally { server.closeAllConnections(); server.close(); }
}

const online = (o = {}) => ({
  name: 'Web Customer', email: 'web@example.com', phone: '555-0199', pickup_date: '2026-12-01', pickup_time: '15:30',
  items: [{ product_id: 1, quantity: 2 }, { product_id: 4, quantity: 1, cut_instructions: 'double ground' }], ...o,
});

test('online orders arrive unread and can be marked seen', () => withServer(async (req) => {
  const { data: o } = await req('/api/orders', { method: 'POST', body: online(), auth: false });
  assert.equal(o.pickup_time, '15:30');
  await req('/api/admin/orders', { method: 'POST', body: { name: 'Phone Pat', items: [{ name: 'Bacon', quantity: 1 }] } });

  let { data: counts } = await req('/api/admin/counts');
  assert.equal(counts.unseen_online, 1, 'staff-entered orders are not "unread"');
  assert.equal(counts.open_orders, 2);

  const { data: list } = await req('/api/admin/online');
  assert.deepEqual(list.map((x) => x.id), [o.id], 'only online orders on the Online tab');
  assert.equal(list[0].items.length, 2);
  assert.equal(list[0].customer_name, 'Web Customer');

  assert.equal((await req(`/api/admin/orders/${o.id}/seen`, { method: 'POST' })).status, 200);
  ({ data: counts } = await req('/api/admin/counts'));
  assert.equal(counts.unseen_online, 0);

  await req('/api/orders', { method: 'POST', body: online({ email: 'b@example.com', phone: '555-0177' }), auth: false });
  await req('/api/admin/online/seen-all', { method: 'POST' });
  ({ data: counts } = await req('/api/admin/counts'));
  assert.equal(counts.unseen_online, 0);
  assert.equal((await req('/api/orders', { method: 'POST', body: online({ pickup_time: '25:99' }), auth: false })).status, 400);
}));

test('prep board lists open orders by pickup time and items can be ticked off', () => withServer(async (req) => {
  const mk = (name, pickup_date, pickup_time) => req('/api/admin/orders', {
    method: 'POST', body: { name, pickup_date, pickup_time, items: [{ name: 'Ribeye Steak', quantity: 1, unit: 'lb' }, { name: 'Bacon', quantity: 2 }] },
  });
  const later = (await mk('Later', '2026-12-02', '09:00')).data;
  const soon = (await mk('Soon', '2026-12-01', '16:00')).data;
  const sooner = (await mk('Sooner', '2026-12-01', '10:00')).data;
  const undated = (await mk('Whenever')).data;
  const done = (await mk('Done', '2026-11-30')).data;
  await req(`/api/admin/orders/${done.id}`, { method: 'PATCH', body: { status: 'picked_up' } });

  let { data: board } = await req('/api/admin/board');
  assert.deepEqual(board.map((o) => o.customer_name), ['Sooner', 'Soon', 'Later', 'Whenever']);

  const item = sooner.items[0];
  const r = await req(`/api/admin/items/${item.id}`, { method: 'PATCH', body: { packed: true } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'preparing', 'packing the first item starts the order');
  assert.equal(r.data.items.find((i) => i.id === item.id).packed, 1);
  await req(`/api/admin/items/${item.id}`, { method: 'PATCH', body: { packed: false } });
  ({ data: board } = await req('/api/admin/board'));
  assert.equal(board[0].items[0].packed, 0);
  assert.ok(later && soon && undated);
  assert.equal((await req('/api/admin/items/99999', { method: 'PATCH', body: { packed: true } })).status, 404);
}));

test('admin screens get a live event when an online order comes in', () => withServer(async (req) => {
  const ac = new AbortController();
  const res = await fetch(req.base + '/api/admin/events', { headers: { Cookie: req.Cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const got = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return buf;
      buf += Buffer.from(value).toString();
      if (buf.includes('online-order')) return buf;
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  const { data: o } = await req('/api/orders', { method: 'POST', body: online(), auth: false });
  const text = await got;
  ac.abort();
  const evt = JSON.parse(text.split('data: ').pop().split('\n')[0]);
  assert.equal(evt.type, 'online-order');
  assert.equal(evt.id, o.id);
  assert.equal(evt.name, 'Web Customer');

  const anon = await fetch(req.base + '/api/admin/events');
  assert.equal(anon.status, 401, 'events need login');
}));

test('browse orders with items, filtered by status, pickup date, source and search', () => withServer(async (req) => {
  const mk = (body) => req('/api/admin/orders', { method: 'POST', body });
  const a = (await mk({ name: 'Ann', pickup_date: '2026-12-01', items: [{ name: 'Beef Brisket', quantity: 12, unit: 'lb', cut_instructions: 'trimmed' }, { name: 'Bacon', quantity: 2, unit: 'lb' }] })).data;
  const b = (await mk({ name: 'Bob', pickup_date: '2026-12-03', items: [{ name: 'beef brisket', quantity: 5, unit: 'lb' }] })).data;
  const c = (await mk({ name: 'Cal', items: [{ name: 'Whole Chicken', quantity: 2 }] })).data;
  const d = (await mk({ name: 'Dee', pickup_date: '2026-11-20', status: 'picked_up', items: [{ name: 'Beef Brisket', quantity: 3, unit: 'lb' }] })).data;
  await req('/api/orders', { method: 'POST', body: online({ pickup_date: '2026-12-02' }), auth: false });

  const ids = async (qs) => (await req(`/api/admin/orders/browse?${qs}`)).data.map((o) => o.customer_name);
  assert.deepEqual(await ids(''), ['Ann', 'Web Customer', 'Bob', 'Cal'], 'open orders by pickup date, undated last');
  assert.deepEqual(await ids('show=all'), ['Dee', 'Ann', 'Web Customer', 'Bob', 'Cal']);
  assert.deepEqual(await ids('show=picked_up'), ['Dee']);
  assert.deepEqual(await ids('from=2026-12-01&to=2026-12-02'), ['Ann', 'Web Customer']);
  assert.deepEqual(await ids('nodate=1'), ['Cal']);
  assert.deepEqual(await ids('source=online'), ['Web Customer']);
  assert.deepEqual(await ids('q=brisket&show=all'), ['Dee', 'Ann', 'Bob']);
  assert.deepEqual(await ids('q=trimmed'), ['Ann'], 'search includes cut instructions');
  assert.deepEqual(await ids(`q=%23${b.id}`), ['Bob'], 'search by #number');
  const { data } = await req('/api/admin/orders/browse?q=Ann');
  assert.equal(data[0].items.length, 2);
  assert.ok(a && c && d);
}));
