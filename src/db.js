'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone       TEXT,
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
  delivery_address    TEXT,
  notes               TEXT,
  total_cents         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  product_name      TEXT NOT NULL,
  unit              TEXT NOT NULL,
  quantity          REAL NOT NULL CHECK (quantity > 0),
  unit_price_cents  INTEGER NOT NULL,
  line_total_cents  INTEGER NOT NULL,
  cut_instructions  TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`;

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
  db.exec(SCHEMA);

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

module.exports = { openDb, transaction };
