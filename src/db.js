'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE COLLATE NOCASE,
  phone       TEXT,
  phone_key   TEXT,   -- digits only, used to match returning customers
  name_key    TEXT,   -- lower-case name, used to match returning customers
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  unit        TEXT NOT NULL CHECK (unit IN ('lb', 'each')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  status              TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'preparing', 'ready', 'picked_up', 'cancelled')),
  fulfillment         TEXT NOT NULL DEFAULT 'pickup' CHECK (fulfillment IN ('pickup', 'delivery')),
  pickup_date         TEXT,
  pickup_time         TEXT,                            -- 'HH:MM', optional "ready by" time
  delivery_address    TEXT,
  notes               TEXT,
  total_cents         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  source              TEXT NOT NULL DEFAULT 'online',  -- online | manual | import
  order_ref           TEXT,                            -- order number from an imported spreadsheet
  import_key          TEXT UNIQUE,                     -- prevents importing the same order twice
  seen_at             TEXT,                            -- when staff first saw an online order (NULL = unread)
  payment_status      TEXT                             -- 'paid' when paid online (Stripe); NULL = pay at pickup
);

CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        INTEGER REFERENCES products(id),  -- NULL for items not in the catalog
  product_name      TEXT NOT NULL,
  unit              TEXT NOT NULL,
  quantity          REAL NOT NULL CHECK (quantity > 0),
  unit_price_cents  INTEGER NOT NULL,
  line_total_cents  INTEGER NOT NULL,
  cut_instructions  TEXT,
  packed            INTEGER NOT NULL DEFAULT 0       -- ticked off on the prep board
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_key);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name_key);
`;

const phoneKey = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
};
const nameKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ') || null;

// Add columns introduced after a database was created.
function ensureColumn(db, table, column, definition, afterAdd) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  if (afterAdd) db.exec(afterAdd);
}

// Upgrade databases created by the first version of the app.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (cols.length === 0 || cols.includes('source')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  transaction(db, () => {
    db.exec(`
      CREATE TABLE customers_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE COLLATE NOCASE,
        phone TEXT, phone_key TEXT, name_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO customers_new (id, name, email, phone, created_at) SELECT id, name, email, phone, created_at FROM customers;
      DROP TABLE customers;
      ALTER TABLE customers_new RENAME TO customers;

      CREATE TABLE order_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        product_name TEXT NOT NULL, unit TEXT NOT NULL, quantity REAL NOT NULL CHECK (quantity > 0),
        unit_price_cents INTEGER NOT NULL, line_total_cents INTEGER NOT NULL, cut_instructions TEXT);
      INSERT INTO order_items_new SELECT id, order_id, product_id, product_name, unit, quantity,
        unit_price_cents, line_total_cents, cut_instructions FROM order_items;
      DROP TABLE order_items;
      ALTER TABLE order_items_new RENAME TO order_items;

      ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'online';
      ALTER TABLE orders ADD COLUMN order_ref TEXT;
      ALTER TABLE orders ADD COLUMN import_key TEXT;
      CREATE UNIQUE INDEX idx_orders_import_key ON orders(import_key);
    `);
    const update = db.prepare('UPDATE customers SET phone_key = ?, name_key = ? WHERE id = ?');
    for (const c of db.prepare('SELECT id, name, phone FROM customers').all()) update.run(phoneKey(c.phone), nameKey(c.name), c.id);
  });
  db.exec('PRAGMA foreign_keys = ON');
}

// Starter catalog. Edit freely — prices are stored in cents.
const SEED_PRODUCTS = [
  ['Ribeye Steak', 'Beef', 'lb', 2499],
  ['New York Strip', 'Beef', 'lb', 2199],
  ['Filet Mignon', 'Beef', 'lb', 3499],
  ['Ground Beef (80/20)', 'Beef', 'lb', 699],
  ['Beef Brisket', 'Beef', 'lb', 899],
  ['Chuck Roast', 'Beef', 'lb', 899],
  ['Short Ribs', 'Beef', 'lb', 1099],
  ['Pork Chops (bone-in)', 'Pork', 'lb', 699],
  ['Pork Shoulder', 'Pork', 'lb', 499],
  ['Baby Back Ribs', 'Pork', 'lb', 799],
  ['Thick-Cut Bacon', 'Pork', 'lb', 999],
  ['Italian Sausage', 'Pork', 'lb', 749],
  ['Whole Chicken', 'Poultry', 'each', 1499],
  ['Chicken Breast (boneless)', 'Poultry', 'lb', 699],
  ['Chicken Thighs', 'Poultry', 'lb', 449],
  ['Lamb Chops', 'Lamb', 'lb', 2299],
  ['Leg of Lamb', 'Lamb', 'lb', 1399],
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  db.exec(SCHEMA);
  ensureColumn(db, 'orders', 'pickup_time', 'TEXT');
  ensureColumn(db, 'orders', 'seen_at', 'TEXT', 'UPDATE orders SET seen_at = created_at');  // existing orders count as seen
  ensureColumn(db, 'order_items', 'packed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'orders', 'payment_status', 'TEXT');

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM products').get();
  if (n === 0) {
    const insert = db.prepare('INSERT INTO products (name, category, unit, price_cents) VALUES (?, ?, ?, ?)');
    for (const p of SEED_PRODUCTS) insert.run(...p);
  }
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const getSetting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

module.exports = { openDb, transaction, phoneKey, nameKey, getSetting, setSetting };
