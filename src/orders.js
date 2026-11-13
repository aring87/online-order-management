'use strict';

const { phoneKey, nameKey } = require('./db');

/**
 * Find the customer this order belongs to, or create them.
 * Match order: email → phone number → name (only when the contact details don't conflict).
 * Missing contact details are filled in on the existing record.
 */
function findOrCreateCustomer(db, { name, email, phone }, { refresh = false } = {}) {
  email = email ? String(email).trim().toLowerCase() : null;
  phone = phone ? String(phone).trim() : null;
  name = String(name || '').trim() || email || phone;
  const pKey = phoneKey(phone);
  const nKey = nameKey(name);

  let c = null;
  if (email) c = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
  // Same phone counts unless both records have different emails (e.g. a shared family phone).
  if (!c && pKey) {
    c = db.prepare('SELECT * FROM customers WHERE phone_key = ? AND (? IS NULL OR email IS NULL) ORDER BY id LIMIT 1')
      .get(pKey, email);
  }
  if (!c && nKey) {
    // Same name only counts as the same person if their email/phone don't contradict each other.
    c = db.prepare(`
      SELECT * FROM customers WHERE name_key = ?
        AND (? IS NULL OR email IS NULL OR email = ?)
        AND (? IS NULL OR phone_key IS NULL OR phone_key = ?)
      ORDER BY id LIMIT 1`).get(nKey, email, email, pKey, pKey);
  }

  if (!c) {
    const row = db.prepare('INSERT INTO customers (name, email, phone, phone_key, name_key) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(name, email, phone, pKey, nKey);
    return { id: row.id, created: true };
  }

  // Fill in blanks (or refresh details for a customer ordering online themselves).
  const emailFree = email && !db.prepare('SELECT 1 FROM customers WHERE email = ? AND id != ?').get(email, c.id);
  const next = {
    name: refresh ? name : c.name,
    email: (refresh || !c.email) && emailFree ? email : c.email,
    phone: (refresh || !c.phone) && phone ? phone : c.phone,
  };
  db.prepare('UPDATE customers SET name = ?, email = ?, phone = ?, phone_key = ?, name_key = ? WHERE id = ?')
    .run(next.name, next.email, next.phone, phoneKey(next.phone), nameKey(next.name), c.id);
  return { id: c.id, created: false };
}

/**
 * Insert an order and its items. Items: { productId?, name, unit, quantity, unitPriceCents, lineTotalCents, cut? }
 * Returns the new order id.
 */
function insertOrder(db, o) {
  const total = o.items.reduce((sum, it) => sum + it.lineTotalCents, 0);
  const { id } = db.prepare(`
    INSERT INTO orders (customer_id, status, fulfillment, pickup_date, delivery_address, notes, total_cents,
                        created_at, source, order_ref, import_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?) RETURNING id`).get(
    o.customerId, o.status || 'new', o.fulfillment || 'pickup', o.pickupDate || null,
    o.fulfillment === 'delivery' ? o.deliveryAddress || null : null, o.notes || null, total,
    o.createdAt || null, o.source || 'online', o.orderRef || null, o.importKey || null);

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit, quantity, unit_price_cents, line_total_cents, cut_instructions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const it of o.items) {
    insertItem.run(id, it.productId ?? null, it.name, it.unit || 'each', it.quantity,
      it.unitPriceCents, it.lineTotalCents, it.cut || null);
  }
  return id;
}

function getOrderWithItems(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  return order;
}

module.exports = { findOrCreateCustomer, insertOrder, getOrderWithItems };
