'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { transaction } = require('./db');

const STATUSES = ['new', 'preparing', 'ready', 'picked_up', 'cancelled'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  return { name, email, phone, fulfillment, pickupDate, deliveryAddress, notes, items };
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

function getOrderWithItems(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  return order;
}

function createApp(db, { adminPassword, sessionSecret = crypto.randomBytes(32).toString('hex') }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  const limiter = loginLimiter();
  const isAdmin = (req) => validToken(sessionSecret, readCookie(req, COOKIE));
  const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Please log in' }));
  const cookieOpts = (req) => `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;

  // ---------- Public ----------
  app.get('/api/products', (req, res) => {
    res.json(db.prepare('SELECT id, name, category, unit, price_cents FROM products WHERE active = 1 ORDER BY category, name').all());
  });

  app.post('/api/orders', (req, res) => {
    const o = validateOrder(req.body || {}, db);
    const order = transaction(db, () => {
      // Returning customers are matched by email; their contact info is refreshed.
      const customer = db.prepare(`
        INSERT INTO customers (name, email, phone) VALUES (?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET name = excluded.name, phone = excluded.phone
        RETURNING id`).get(o.name, o.email, o.phone);

      const total = o.items.reduce((sum, it) => sum + it.lineTotal, 0);
      const { id: orderId } = db.prepare(`
        INSERT INTO orders (customer_id, fulfillment, pickup_date, delivery_address, notes, total_cents)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(
        customer.id, o.fulfillment, o.pickupDate || null,
        o.fulfillment === 'delivery' ? o.deliveryAddress : null, o.notes || null, total);

      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, unit, quantity, unit_price_cents, line_total_cents, cut_instructions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const it of o.items) {
        insertItem.run(orderId, it.product.id, it.product.name, it.product.unit, it.quantity,
          it.product.price_cents, it.lineTotal, it.cut || null);
      }
      return getOrderWithItems(db, orderId);
    });
    res.status(201).json(order);
  });

  // ---------- Admin ----------
  // The admin page itself holds no data; it shows a login screen until the API accepts the session.
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip;
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
  app.get('/api/admin/session', (req, res) => res.json({ ok: true }));

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
      GROUP BY c.id
      ORDER BY last_order_at DESC`).all(q, q, q));
  });

  app.get('/api/admin/customers/:id', (req, res) => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const orderIds = db.prepare('SELECT id FROM orders WHERE customer_id = ? ORDER BY created_at DESC, id DESC').all(customer.id);
    customer.orders = orderIds.map(({ id }) => getOrderWithItems(db, id));
    res.json(customer);
  });

  app.get('/api/admin/orders', (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    res.json(db.prepare(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
             (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
      FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE (? IS NULL OR o.status = ?)
      ORDER BY o.created_at DESC, o.id DESC`).all(status, status));
  });

  app.patch('/api/admin/orders/:id', (req, res) => {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const result = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, Number(req.params.id));
    if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
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
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp, STATUSES };
