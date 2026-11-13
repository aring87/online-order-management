'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { readSpreadsheet, parseCsv } = require('../src/importer');

async function withServer(fn, db = openDb(':memory:')) {
  const server = createApp(db, { adminPassword: 'secret' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'secret' }),
  });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (p, { method = 'GET', body, raw, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { Cookie, ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: raw || (body && JSON.stringify(body)),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  try { await fn(req); } finally { server.close(); }
}

// A typical hand-kept order sheet: a title row, merged-style rows where the customer is only on the first line.
async function sampleXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Orders');
  ws.addRow(['Holiday Orders 2026']);
  ws.addRow(['Date', 'Customer', 'Phone', 'Item', 'Lbs', 'Price/lb', 'Total', 'Notes']);
  ws.addRow([new Date(Date.UTC(2026, 10, 2)), 'John Smith', '(555) 010-1234', 'Ribeye Steak', 3, 24.99, 74.97, 'cut 1" thick']);
  ws.addRow(['', '', '', 'Ground Beef (80/20)', 5, 6.99, { formula: 'E4*F4', result: 34.95 }, '']);
  ws.addRow([new Date(Date.UTC(2026, 10, 5)), 'Sue Park', '555-020-9999', 'Whole Turkey', '18 lb', '', '$62.00', '']);
  ws.addRow([new Date(Date.UTC(2026, 10, 9)), 'john smith', '555.010.1234', 'Pork Chops (bone-in)', 2, 6.99, 13.98, '']);
  ws.addRow([new Date(Date.UTC(2026, 10, 9)), 'Nobody', '', '', '', '', '', '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('reads a spreadsheet and guesses the columns', async () => {
  const sheet = await readSpreadsheet(await sampleXlsx(), 'orders.xlsx');
  assert.deepEqual(sheet.headers, ['Date', 'Customer', 'Phone', 'Item', 'Lbs', 'Price/lb', 'Total', 'Notes']);
  assert.equal(sheet.rows.length, 5);
  assert.deepEqual(sheet.mapping, {
    order_date: 0, customer_name: 1, phone: 2, product: 3, quantity: 4, unit_price: 5, line_total: 6, notes: 7,
  });
});

test('imports an Excel sheet into customers and orders, without duplicates on re-import', () => withServer(async (req) => {
  const preview = await req('/api/admin/import/preview?filename=orders.xlsx', { method: 'POST', raw: await sampleXlsx() });
  assert.equal(preview.status, 200);
  const { headers, rows, mapping } = preview.data;
  mapping.cut_instructions = mapping.notes; delete mapping.notes;

  const r = await req('/api/admin/import', { method: 'POST', body: { headers, rows, mapping } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.orders_created, 3);
  assert.equal(r.data.items_created, 4);
  assert.equal(r.data.customers_created, 2, 'John Smith matched by phone despite different formatting/case');
  assert.equal(r.data.skipped.length, 1);

  const { data: customers } = await req('/api/admin/customers', {});
  const john = customers.find((c) => c.name === 'John Smith');
  assert.equal(john.order_count, 2);
  const { data: detail } = await req(`/api/admin/customers/${john.id}`);
  const first = detail.orders.find((o) => o.items.length === 2);
  assert.equal(first.created_at.slice(0, 10), '2026-11-02');
  assert.equal(first.status, 'picked_up');
  assert.equal(first.total_cents, 7497 + 3495);
  assert.equal(first.items[0].cut_instructions, 'cut 1" thick');
  assert.equal(first.items[0].unit, 'lb');

  const { data: sue } = await req(`/api/admin/customers/${customers.find((c) => c.name === 'Sue Park').id}`);
  assert.equal(sue.orders[0].items[0].quantity, 18);
  assert.equal(sue.orders[0].items[0].unit, 'lb');
  assert.equal(sue.orders[0].items[0].line_total_cents, 6200);

  const again = await req('/api/admin/import', { method: 'POST', body: { headers, rows, mapping } });
  assert.equal(again.data.orders_created, 0);
  assert.equal(again.data.duplicates, 3);
}));

test('imports CSV with order numbers and first/last names', () => withServer(async (req) => {
  const csv = 'Order #,First Name,Last Name,Email,Product,Qty,Unit,Price\n'
    + '1001,Ann,Lee,ann@x.com,Brisket,4.5,lb,8.99\n'
    + '1001,,,,Bacon,"2",lb,9.99\n'
    + '1002,Ann,Lee,ANN@x.com,"Sausage, hot",1,each,7.49\n';
  const { data: p } = await req('/api/admin/import/preview?filename=o.csv', { method: 'POST', raw: Buffer.from(csv) });
  assert.equal(p.mapping.order_ref, 0);
  assert.equal(p.mapping.first_name, 1);
  assert.equal(p.mapping.last_name, 2);
  const { data } = await req('/api/admin/import', { method: 'POST', body: { ...p, status: 'new' } });
  assert.equal(data.orders_created, 2);
  assert.equal(data.customers_created, 1);
  const { data: orders } = await req('/api/admin/orders?q=1001');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].order_ref, '1001');
  assert.equal(orders[0].total_cents, Math.round(4.5 * 899) + 2 * 999);
  assert.equal(orders[0].status, 'new');
}));

test('rejects unsupported files with a helpful message', () => withServer(async (req) => {
  const r = await req('/api/admin/import/preview?filename=old.xls', { method: 'POST', raw: Buffer.from('xx') });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /\.xlsx/);
}));

test('staff can enter, search, export and delete orders', () => withServer(async (req) => {
  const r = await req('/api/admin/orders', {
    method: 'POST',
    body: {
      name: 'Walk In Wally', phone: '555 777 1212', order_date: '2026-11-10', status: 'preparing',
      items: [
        { name: 'Ribeye Steak', quantity: 2, unit: 'lb', unit_price_cents: 2499, cut_instructions: 'thin' },
        { name: 'Venison backstrap', quantity: 1, unit: 'each', unit_price_cents: 4000 },
      ],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.total_cents, 2 * 2499 + 4000);
  assert.equal(r.data.source, 'manual');
  assert.ok(r.data.items[0].product_id, 'catalog item linked');
  assert.equal(r.data.items[1].product_id, null, 'free-text item allowed');

  assert.equal((await req('/api/admin/orders', { method: 'POST', body: { name: '', items: [] } })).status, 400);

  // Search by item name finds the customer
  const { data: byItem } = await req('/api/admin/customers?q=venison');
  assert.deepEqual(byItem.map((c) => c.name), ['Walk In Wally']);
  const { data: ordersByItem } = await req('/api/admin/orders?q=venison');
  assert.equal(ordersByItem.length, 1);
  assert.match(ordersByItem[0].item_summary, /Ribeye Steak \(2 lb\)/);

  const exp = await req('/api/admin/export.csv');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /orders-.*\.csv/);
  const lines = parseCsv(exp.data);
  assert.equal(lines[0][0], 'Order #');
  assert.ok(lines.some((l) => l.includes('Venison backstrap')));

  assert.equal((await req(`/api/admin/orders/${r.data.id}`, { method: 'DELETE' })).status, 200);
  const { data: after } = await req('/api/admin/customers');
  assert.equal(after.length, 0, 'customer with no remaining orders removed');
}));

test('export protects against spreadsheet formulas in customer text', () => withServer(async (req) => {
  await req('/api/admin/orders', { method: 'POST', body: { name: '=HYPERLINK("x")', items: [{ name: 'Bacon', quantity: 1 }] } });
  const exp = await req('/api/admin/export.csv');
  assert.match(exp.data, /'=HYPERLINK/);
}));

test('upgrades a database created by the first version', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'butcher-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL,
      unit TEXT NOT NULL CHECK (unit IN ('lb', 'each')), price_cents INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'new', fulfillment TEXT NOT NULL DEFAULT 'pickup', pickup_date TEXT, delivery_address TEXT,
      notes TEXT, total_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id), product_name TEXT NOT NULL, unit TEXT NOT NULL, quantity REAL NOT NULL,
      unit_price_cents INTEGER NOT NULL, line_total_cents INTEGER NOT NULL, cut_instructions TEXT);
    INSERT INTO products (name, category, unit, price_cents) VALUES ('Ribeye', 'Beef', 'lb', 2499);
    INSERT INTO customers (name, email, phone) VALUES ('Old Timer', 'old@x.com', '555-111-2222');
    INSERT INTO orders (customer_id, total_cents) VALUES (1, 4998);
    INSERT INTO order_items (order_id, product_id, product_name, unit, quantity, unit_price_cents, line_total_cents)
      VALUES (1, 1, 'Ribeye', 'lb', 2, 2499, 4998);`);
  old.close();

  const db = openDb(file);
  const c = db.prepare('SELECT * FROM customers').get();
  assert.equal(c.phone_key, '5551112222');
  assert.equal(db.prepare('SELECT source FROM orders').get().source, 'online');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_items').get().n, 1);
  db.prepare("INSERT INTO customers (name) VALUES ('No Email')").run();
  db.close();
});

test('uses the column heading to tell items are sold by the pound', () => withServer(async (req) => {
  const csv = 'Customer,Item,Weight (lbs),Total\nAl,Whole Turkey,18,62.82\n';
  const { data: p } = await req('/api/admin/import/preview?filename=o.csv', { method: 'POST', raw: Buffer.from(csv) });
  await req('/api/admin/import', { method: 'POST', body: p });
  const { data: orders } = await req('/api/admin/orders');
  assert.equal(orders[0].item_summary, 'Whole Turkey (18 lb)');
}));

test('the bundled sample spreadsheet imports cleanly', () => withServer(async (req) => {
  const file = path.join(__dirname, '..', 'samples', 'sample-orders.xlsx');
  const { data: p } = await req('/api/admin/import/preview?filename=sample-orders.xlsx', { method: 'POST', raw: fs.readFileSync(file) });
  for (const f of ['order_ref', 'order_date', 'customer_name', 'phone', 'email', 'product', 'quantity', 'unit', 'unit_price',
    'line_total', 'cut_instructions', 'pickup_date', 'pickup_time', 'status', 'notes']) {
    assert.ok(p.mapping[f] != null, `guessed column for ${f}`);
  }
  const { data: r } = await req('/api/admin/import', { method: 'POST', body: p });
  assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped.slice(0, 3)));
  assert.ok(r.orders_created > 80);
  assert.equal(r.customers_created, 25, 'same customer recognised despite different phone formats');
  const { data: one } = await req('/api/admin/orders/browse?show=all&q=%231001');
  assert.equal(one.length, 1, 'spreadsheet order numbers are kept');
  assert.equal(one[0].id, 1001);
}));

test('reads Excel times, status words and keeps order numbers for follow-on rows', () => withServer(async (req) => {
  const { toTime, toStatus } = require('../src/importer');
  assert.equal(toTime(new Date(Date.UTC(1899, 11, 30, 15, 30))), '15:30');
  assert.equal(toTime(0.5), '12:00');
  assert.equal(toTime('1899-12-30T09:05:00.000Z'), '09:05');
  assert.equal(toTime('4 pm'), '16:00');
  assert.equal(toStatus('Picked up'), 'picked_up');
  assert.equal(toStatus('DONE'), 'picked_up');
  assert.equal(toStatus('Cutting'), 'preparing');
  assert.equal(toStatus('Ready'), 'ready');
  assert.equal(toStatus('Ordered'), 'new');
  assert.equal(toStatus('cancelled'), 'cancelled');
  assert.equal(toStatus(''), null);

  const csv = 'Order #,Customer,Item,Qty,Status,Pickup Date\n'
    + '77,Ann Lee,Brisket,4,Ready,2099-01-01\n'
    + ',,Bacon,2,,\n'
    + '78,Bo Day,Ribs,3,,2099-01-02\n'
    + '79,Cy Fox,Ribs,3,,2000-01-02\n';
  const { data: p } = await req('/api/admin/import/preview?filename=o.csv', { method: 'POST', raw: Buffer.from(csv) });
  const { data: r } = await req('/api/admin/import', { method: 'POST', body: { ...p, status: 'picked_up' } });
  assert.equal(r.orders_created, 3, 'follow-on row joined order 77');
  const { data: all } = await req('/api/admin/orders/browse?show=all');
  const byId = Object.fromEntries(all.map((o) => [o.id, o]));
  assert.equal(byId[77].items.length, 2);
  assert.equal(byId[77].status, 'ready');
  assert.equal(byId[78].status, 'new', 'future pickup with no status → New');
  assert.equal(byId[79].status, 'picked_up', 'past order with no status → the choice on screen');
  const { data: o } = await req('/api/admin/orders', { method: 'POST', body: { name: 'Next', items: [{ name: 'Bacon', quantity: 1 }] } });
  assert.equal(o.id, 80, 'new orders continue after the imported numbers');
}));

test('a properly capitalised name replaces all-lowercase typing', () => withServer(async (req) => {
  await req('/api/admin/orders', { method: 'POST', body: { name: 'sam whitfield', phone: '555-010-0107', items: [{ name: 'Bacon', quantity: 1 }] } });
  await req('/api/admin/orders', { method: 'POST', body: { name: 'Sam Whitfield', phone: '5550100107', items: [{ name: 'Bacon', quantity: 1 }] } });
  const { data } = await req('/api/admin/customers');
  assert.deepEqual(data.map((c) => [c.name, c.order_count]), [['Sam Whitfield', 2]]);
}));
