'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const express = require('express');
const { transaction } = require('./db');
const { findOrCreateCustomer, insertOrder, getOrderWithItems, listOrdersWithItems } = require('./orders');
const { readSpreadsheet, importRows, FIELDS, ImportError } = require('./importer');
const { createStripe } = require('./stripe');

const STATUSES = ['new', 'preparing', 'ready', 'picked_up', 'cancelled'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPEN_STATUSES = ['new', 'preparing', 'ready'];

function time(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new ValidationError('Invalid time.');
  return t || null;
}

class ValidationError extends Error {}

function str(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function validateOrder(body, db) {
  const name = str(body.name, 120);
  const email = str(body.email, 200).toLowerCase();
  const phone = str(body.phone, 40);
  const fulfillment = body.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const pickupDate = str(body.pickup_date, 20);
  const pickupTime = time(body.pickup_time);
  const deliveryAddress = str(body.delivery_address, 300);
  const notes = str(body.notes, 1000);

  if (!name) throw new ValidationError('Name is required.');
  if (!EMAIL_RE.test(email)) throw new ValidationError('A valid email is required.');
  if (!phone) throw new ValidationError('Phone number is required.');
  if (pickupDate && !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new ValidationError('Invalid date.');
  if (fulfillment === 'delivery' && !deliveryAddress) throw new ValidationError('Delivery address is required.');
  if (!Array.isArray(body.items) || body.items.length === 0) throw new ValidationError('Add at least one item.');
  if (body.items.length > 50) throw new ValidationError('Too many items.');

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const items = body.items.map((it) => {
    const product = getProduct.get(Number(it.product_id));
    if (!product) throw new ValidationError('One of the selected products is not available.');
    const qty = Number(it.quantity);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 500) throw new ValidationError(`Invalid quantity for ${product.name}.`);
    if (product.unit === 'each' && !Number.isInteger(qty)) throw new ValidationError(`${product.name} must be ordered in whole units.`);
    const quantity = Math.round(qty * 100) / 100;
    return {
      product,
      quantity,
      lineTotal: Math.round(quantity * product.price_cents),
      cut: str(it.cut_instructions, 300),
    };
  });

  return { name, email, phone, fulfillment, pickupDate, pickupTime, deliveryAddress, notes, items };
}

// ---------- Admin sessions ----------
// A signed, HttpOnly cookie keeps staff logged in (works in home-screen apps,
// unlike browser Basic-auth prompts).
const COOKIE = 'admin_session';
const SESSION_DAYS = 30;

function sign(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(secret) {
  const expires = String(Date.now() + SESSION_DAYS * 864e5);
  return `${expires}.${sign(secret, expires)}`;
}

function validToken(secret, token) {
  const [expires, sig] = String(token || '').split('.');
  if (!expires || !sig) return false;
  const expected = Buffer.from(sign(secret, expires));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) && Number(expires) > Date.now();
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function passwordMatches(given, password) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

// Simple in-memory brute-force protection: 10 failed logins per IP per 15 min.
function loginLimiter() {
  const failures = new Map();
  const WINDOW = 15 * 60 * 1000;
  return {
    blocked(ip) {
      const f = failures.get(ip);
      if (f && Date.now() - f.start > WINDOW) failures.delete(ip);
      return (failures.get(ip)?.count || 0) >= 10;
    },
    fail(ip) {
      const f = failures.get(ip) || { count: 0, start: Date.now() };
      f.count += 1;
      failures.set(ip, f);
    },
    reset(ip) { failures.delete(ip); },
  };
}

// Staff-entered orders (phone / walk-in): email and phone are optional, items can be anything.
function validateManualOrder(body, db) {
  const name = str(body.name, 120);
  const email = str(body.email, 200).toLowerCase();
  const phone = str(body.phone, 40);
  if (!name) throw new ValidationError('Customer name is required.');
  if (email && !EMAIL_RE.test(email)) throw new ValidationError('That email address doesn\'t look right.');
  const date = (v) => {
    const d = str(v, 20);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ValidationError('Invalid date.');
    return d || null;
  };
  const status = STATUSES.includes(body.status) ? body.status : 'new';
  const fulfillment = body.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  if (!Array.isArray(body.items) || body.items.length === 0) throw new ValidationError('Add at least one item.');
  if (body.items.length > 100) throw new ValidationError('Too many items.');

  const byName = db.prepare('SELECT id FROM products WHERE name = ? COLLATE NOCASE');
  const items = body.items.map((it, i) => {
    const itemName = str(it.name, 200);
    if (!itemName) throw new ValidationError(`Item ${i + 1} needs a name.`);
    const quantity = Math.round(Number(it.quantity) * 100) / 100;
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) throw new ValidationError(`Invalid quantity for ${itemName}.`);
    const unitPriceCents = Math.round(Number(it.unit_price_cents) || 0);
    if (unitPriceCents < 0) throw new ValidationError(`Invalid price for ${itemName}.`);
    return {
      productId: byName.get(itemName)?.id ?? null,
      name: itemName,
      unit: it.unit === 'lb' ? 'lb' : 'each',
      quantity,
      unitPriceCents,
      lineTotalCents: Math.round(quantity * unitPriceCents),
      cut: str(it.cut_instructions, 300),
    };
  });
  return {
    customer: { name, email: email || null, phone: phone || null },
    order: {
      status, fulfillment,
      pickupDate: date(body.pickup_date),
      pickupTime: time(body.pickup_time),
      createdAt: date(body.order_date) ? `${date(body.order_date)} 12:00:00` : null,
      deliveryAddress: str(body.delivery_address, 300),
      notes: str(body.notes, 1000),
      source: 'manual',
      items,
    },
  };
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop Excel treating text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createApp(db, { adminPassword, sessionSecret = crypto.randomBytes(32).toString('hex'), stripe: stripeOpts = {} }) {
  const app = express();
  const smallJson = express.json({ limit: '100kb' });
  // Spreadsheet imports can be large; they get their own body parsers after the login check.
  // Imports can be large, and Stripe webhooks need the exact raw body to check the signature.
  const ownParser = (p) => p.startsWith('/api/admin/import') || p === '/api/stripe/webhook';
  app.use((req, res, next) => (ownParser(req.path) ? next() : smallJson(req, res, next)));

  // Live updates: every change is pushed to open admin screens (prep board, online orders…) instantly.
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const changed = (type, data = {}) => events.emit('change', { type, ...data });

  // Paid Stripe orders flow in as online orders (see src/stripe.js).
  const stripe = createStripe({ db, ...stripeOpts, onOrder: (e) => changed('online-order', e) });
  app.locals.stripe = stripe;
  app.post('/api/stripe/webhook', express.raw({ type: () => true, limit: '1mb' }), stripe.webhook);

  const limiter = loginLimiter();
  // No password = no login screen. (server.js then only listens on this computer.)
  const loginRequired = Boolean(adminPassword);
  const isAdmin = (req) => !loginRequired || validToken(sessionSecret, readCookie(req, COOKIE));
  const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Please log in' }));
  const cookieOpts = (req) => `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;

  // ---------- Public ----------
  app.get('/api/products', (req, res) => {
    res.json(db.prepare('SELECT id, name, category, unit, price_cents FROM products WHERE active = 1 ORDER BY category, name').all());
  });

  app.post('/api/orders', (req, res) => {
    const o = validateOrder(req.body || {}, db);
    const order = transaction(db, () => {
      // Returning customers are matched by email / phone; their contact info is refreshed.
      const customer = findOrCreateCustomer(db, { name: o.name, email: o.email, phone: o.phone }, { refresh: true });
      const orderId = insertOrder(db, {
        customerId: customer.id,
        fulfillment: o.fulfillment,
        pickupDate: o.pickupDate,
        pickupTime: o.pickupTime,
        deliveryAddress: o.deliveryAddress,
        notes: o.notes,
        source: 'online',
        items: o.items.map((it) => ({
          productId: it.product.id, name: it.product.name, unit: it.product.unit, quantity: it.quantity,
          unitPriceCents: it.product.price_cents, lineTotalCents: it.lineTotal, cut: it.cut,
        })),
      });
      return getOrderWithItems(db, orderId);
    });
    changed('online-order', { id: order.id, name: order.customer_name, total_cents: order.total_cents });
    res.status(201).json(order);
  });

  // ---------- Admin ----------
  // The admin page itself holds no data; it shows a login screen until the API accepts the session.
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip;
    if (!loginRequired) return res.json({ ok: true });
    if (limiter.blocked(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!passwordMatches(req.body?.password, adminPassword)) {
      limiter.fail(ip);
      return res.status(401).json({ error: 'Wrong password' });
    }
    limiter.reset(ip);
    res.set('Set-Cookie', `${COOKIE}=${makeToken(sessionSecret)}; Max-Age=${SESSION_DAYS * 86400}; ${cookieOpts(req)}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieOpts(req)}`);
    res.json({ ok: true });
  });

  app.use('/api/admin', requireAdmin);
  app.get('/api/admin/session', (req, res) => res.json({ ok: true, login: loginRequired }));

  app.get('/api/admin/customers', (req, res) => {
    const q = `%${str(req.query.q, 100)}%`;
    res.json(db.prepare(`
      SELECT c.id, c.name, c.email, c.phone, c.created_at,
             COUNT(o.id) AS order_count,
             COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total_cents END), 0) AS total_spent_cents,
             MAX(o.created_at) AS last_order_at,
             SUM(CASE WHEN o.status IN ('new', 'preparing', 'ready') THEN 1 ELSE 0 END) AS open_orders
      FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
      WHERE c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?
         OR EXISTS (SELECT 1 FROM orders o2 JOIN order_items i ON i.order_id = o2.id
                    WHERE o2.customer_id = c.id AND i.product_name LIKE ?)
      GROUP BY c.id
      ORDER BY last_order_at DESC, c.name COLLATE NOCASE`).all(q, q, q, q));
  });

  app.get('/api/admin/customers/:id', (req, res) => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const orderIds = db.prepare('SELECT id FROM orders WHERE customer_id = ? ORDER BY created_at DESC, id DESC').all(customer.id);
    customer.orders = orderIds.map(({ id }) => getOrderWithItems(db, id));
    res.json(customer);
  });

  // All orders, optionally filtered by status and a search (customer name/email/phone, item, or order number).
  app.get('/api/admin/orders', (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const term = str(req.query.q, 100);
    const q = `%${term}%`;
    res.json(db.prepare(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
             (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
             (SELECT GROUP_CONCAT(i.product_name || ' (' || printf('%g', i.quantity) || CASE i.unit WHEN 'lb' THEN ' lb' ELSE '' END || ')', ', ')
                FROM order_items i WHERE i.order_id = o.id) AS item_summary
      FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE (? IS NULL OR o.status = ?)
        AND (? = '' OR c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR o.order_ref LIKE ? OR CAST(o.id AS TEXT) = ?
             OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.product_name LIKE ?))
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 1000`).all(status, status, term, q, q, q, q, term, q));
  });

  // Orders with their items, for the "Organize by customer / item / pickup day" views.
  // ?show=open|all|<status>  &from=YYYY-MM-DD&to=YYYY-MM-DD (pickup date)  &nodate=1 (only orders without a date)
  // &source=online|manual|import  &q=search
  app.get('/api/admin/orders/browse', (req, res) => {
    const where = ['1 = 1'];
    const params = [];
    const show = str(req.query.show, 20) || 'open';
    if (show === 'open') where.push("o.status IN ('new', 'preparing', 'ready')");
    else if (STATUSES.includes(show)) { where.push('o.status = ?'); params.push(show); }
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (req.query.nodate === '1') where.push('o.pickup_date IS NULL');
    if (isDate(req.query.from)) { where.push('o.pickup_date >= ?'); params.push(req.query.from); }
    if (isDate(req.query.to)) { where.push('o.pickup_date <= ?'); params.push(req.query.to); }
    if (['online', 'manual', 'import'].includes(req.query.source)) { where.push('o.source = ?'); params.push(req.query.source); }
    const term = str(req.query.q, 100);
    if (term) {
      const q = `%${term}%`;
      where.push(`(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR o.order_ref LIKE ? OR CAST(o.id AS TEXT) = ?
                   OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND (i.product_name LIKE ? OR i.cut_instructions LIKE ?)))`);
      params.push(q, q, q, q, term.replace(/^#/, ''), q, q);
    }
    res.json(listOrdersWithItems(db, where.join(' AND '), params,
      'o.pickup_date IS NULL, o.pickup_date, o.pickup_time IS NULL, o.pickup_time, o.created_at DESC, o.id DESC', 3000));
  });

  app.post('/api/admin/orders', (req, res) => {
    const { customer, order } = validateManualOrder(req.body || {}, db);
    const created = transaction(db, () => {
      const c = findOrCreateCustomer(db, customer);
      return getOrderWithItems(db, insertOrder(db, { ...order, customerId: c.id }));
    });
    changed('order', { id: created.id });
    res.status(201).json(created);
  });

  app.delete('/api/admin/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    transaction(db, () => {
      db.prepare('DELETE FROM orders WHERE id = ?').run(id);
      // Remove the customer too if this was their only order.
      db.prepare('DELETE FROM customers WHERE id = ? AND NOT EXISTS (SELECT 1 FROM orders WHERE customer_id = ?)')
        .run(order.customer_id, order.customer_id);
    });
    changed('order', { id });
    res.json({ ok: true });
  });

  // ---------- Live updates (Server-Sent Events) ----------
  app.get('/api/admin/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const send = (e) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    events.on('change', send);
    req.on('close', () => { clearInterval(ping); events.off('change', send); });
  });

  // Badge numbers for the tabs.
  app.get('/api/admin/counts', (req, res) => {
    res.json(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE source = 'online' AND seen_at IS NULL) AS unseen_online,
        (SELECT COUNT(*) FROM orders WHERE status IN ('new', 'preparing', 'ready')) AS open_orders`).get());
  });

  // ---------- Prep board ----------
  // Open orders with items, soonest pickup first (orders with no date go last, oldest first).
  app.get('/api/admin/board', (req, res) => {
    res.json(listOrdersWithItems(db, `o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`, OPEN_STATUSES,
      `o.pickup_date IS NULL, o.pickup_date, o.pickup_time IS NULL, o.pickup_time, o.created_at, o.id`, 500));
  });

  // Tick an item off as cut & packed.
  app.patch('/api/admin/items/:id', (req, res) => {
    const id = Number(req.params.id);
    const packed = req.body?.packed ? 1 : 0;
    const item = db.prepare('UPDATE order_items SET packed = ? WHERE id = ? RETURNING *').get(packed, id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    // Starting to pack a New order moves it to Preparing automatically.
    if (packed) db.prepare("UPDATE orders SET status = 'preparing' WHERE id = ? AND status = 'new'").run(item.order_id);
    changed('order', { id: item.order_id });
    res.json(getOrderWithItems(db, item.order_id));
  });

  // ---------- Online orders ----------
  app.get('/api/admin/online', (req, res) => {
    const show = req.query.show === 'all' ? '1 = 1' : "(o.seen_at IS NULL OR o.status IN ('new', 'preparing', 'ready'))";
    res.json(listOrdersWithItems(db, `o.source = 'online' AND ${show}`, [], 'o.seen_at IS NOT NULL, o.created_at DESC, o.id DESC', 200));
  });

  app.post('/api/admin/orders/:id/seen', (req, res) => {
    const r = db.prepare("UPDATE orders SET seen_at = COALESCE(seen_at, datetime('now')) WHERE id = ?").run(Number(req.params.id));
    if (r.changes === 0) return res.status(404).json({ error: 'Order not found' });
    changed('seen');
    res.json({ ok: true });
  });

  app.post('/api/admin/online/seen-all', (req, res) => {
    db.prepare("UPDATE orders SET seen_at = datetime('now') WHERE source = 'online' AND seen_at IS NULL").run();
    changed('seen');
    res.json({ ok: true });
  });

  app.get('/api/admin/orders/:id', (req, res) => {
    const order = getOrderWithItems(db, Number(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  });

  // ---------- Stripe ----------
  app.get('/api/admin/stripe', (req, res) => res.json(stripe.status));
  app.post('/api/admin/stripe/sync', async (req, res) => {
    if (!stripe.status.enabled) return res.status(400).json({ error: 'Stripe is not connected yet. Add STRIPE_SECRET_KEY to the .env file.' });
    try {
      const r = await stripe.sync();
      res.json({ ...r, status: stripe.status });
    } catch (err) {
      res.status(502).json({ error: err.message, status: stripe.status });
    }
  });

  // ---------- Spreadsheet import / export ----------
  app.get('/api/admin/import/fields', (req, res) => {
    res.json(Object.entries(FIELDS).map(([key, f]) => ({ key, label: f.label })));
  });

  app.post('/api/admin/import/preview', express.raw({ type: () => true, limit: '25mb' }), async (req, res, next) => {
    try {
      if (!req.body?.length) throw new ImportError('No file received.');
      res.json(await readSpreadsheet(req.body, str(req.query.filename, 200), str(req.query.sheet, 200)));
    } catch (err) { next(err); }
  });

  app.post('/api/admin/import', express.json({ limit: '50mb' }), (req, res) => {
    const { headers, rows, mapping, status } = req.body || {};
    const result = importRows(db, {
      headers, rows, mapping: mapping || {},
      status: STATUSES.includes(status) ? status : 'picked_up',
    });
    if (result.orders_created) changed('import');
    res.json(result);
  });

  // Everything as a spreadsheet (one row per item) — opens directly in Excel.
  app.get('/api/admin/export.csv', (req, res) => {
    const rows = db.prepare(`
      SELECT o.id, o.order_ref, o.created_at, o.status, o.fulfillment, o.pickup_date, o.pickup_time, o.delivery_address, o.notes,
             o.total_cents, o.source, c.name, c.email, c.phone,
             i.product_name, i.quantity, i.unit, i.unit_price_cents, i.line_total_cents, i.cut_instructions
      FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN order_items i ON i.order_id = o.id
      ORDER BY c.name COLLATE NOCASE, o.created_at, o.id, i.id`).all();
    const money = (c) => (c == null ? '' : (c / 100).toFixed(2));
    const header = ['Order #', 'Order ref', 'Order date', 'Status', 'Customer', 'Email', 'Phone', 'Pickup/Delivery',
      'Pickup date', 'Ready by', 'Delivery address', 'Item', 'Quantity', 'Unit', 'Unit price', 'Line total', 'Cut instructions',
      'Order notes', 'Order total', 'Source'];
    const lines = [header, ...rows.map((r) => [r.id, r.order_ref, r.created_at.slice(0, 10), r.status, r.name, r.email,
      r.phone, r.fulfillment, r.pickup_date, r.pickup_time, r.delivery_address, r.product_name, r.quantity, r.unit,
      money(r.unit_price_cents), money(r.line_total_cents), r.cut_instructions, r.notes, money(r.total_cents), r.source])];
    const csv = '\uFEFF' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="orders-${today}.csv"`)
      .send(csv);
  });

  app.patch('/api/admin/orders/:id', (req, res) => {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const result = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, Number(req.params.id));
    if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
    changed('order', { id: Number(req.params.id) });
    res.json(getOrderWithItems(db, Number(req.params.id)));
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, file) {
      // The service worker must always be fetched fresh so app updates roll out.
      if (file.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
    },
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError || err instanceof ImportError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too big.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp, STATUSES };
