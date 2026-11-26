'use strict';

// Half-hour (or other length) pickup slots and how full each one is on a given day.

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const slotStart = (time, step) => hhmm(Math.floor(toMin(time) / step) * step);

/** Every slot of the day with its order count. Cancelled orders don't count. */
function slotsFor(db, date, { open, close, slot_minutes: step, slot_max: max }) {
  const orders = db.prepare(`
    SELECT o.id, o.slot_number, o.pickup_date, o.customer_id, o.pickup_time, o.status, o.source, o.payment_status, c.name AS customer_name,
           (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.pickup_date = ? AND o.status != 'cancelled'
    ORDER BY o.pickup_time, o.id`).all(date);

  const slots = new Map();
  for (let m = toMin(open); m + step <= toMin(close); m += step) slots.set(hhmm(m), []);
  const noTime = [];
  for (const o of orders) {
    if (!o.pickup_time) { noTime.push(o); continue; }
    const s = slotStart(o.pickup_time, step);
    if (!slots.has(s)) slots.set(s, []);          // a time outside opening hours still shows up
    slots.get(s).push(o);
  }
  const list = [...slots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, os]) => ({
    start,
    numbers: numberRange(start),
    end: hhmm(toMin(start) + step),
    count: os.length,
    max,
    full: max > 0 && os.length >= max,
    orders: os,
  }));
  return { date, max, slots: list, no_time: noTime, total: orders.length };
}

/** How many orders are already in the slot this time falls in (for the 10-per-slot limit). */
function slotCount(db, date, time, step) {
  const start = slotStart(time, step);
  const end = hhmm(toMin(start) + step);
  return db.prepare(`
    SELECT COUNT(*) AS n FROM orders
    WHERE pickup_date = ? AND pickup_time >= ? AND pickup_time < ? AND status != 'cancelled'`).get(date, start, end).n;
}

// ---------- Pickup numbers ----------
// Each pickup slot owns a block of numbers for the day: first slot #1-10, second #11-20, ...
// (block size = the per-slot limit), so the number alone tells you when the order is due.
let config = { open: '10:00', close: '18:00', slot_minutes: 30, slot_max: 10 };
function configure(hours) { config = { ...config, ...hours }; }
const blockSize = () => (config.slot_max > 0 ? config.slot_max : 10);

/** 0 for the first slot of the day, 1 for the next…; null if the time is outside opening hours. */
function slotIndex(time) {
  const step = config.slot_minutes;
  const start = toMin(slotStart(time, step));
  const idx = (start - toMin(config.open)) / step;
  if (idx < 0 || start + step > toMin(config.close)) return null;
  return idx;
}
function numberRange(time) {
  const idx = slotIndex(time);
  if (idx == null) return null;
  const first = idx * blockSize() + 1;
  return { first, last: first + blockSize() - 1 };
}

/** Give an order the lowest free number in its slot's block (or none if the block is used up). */
function assignSlotNumber(db, orderId) {
  const o = db.prepare('SELECT id, pickup_date, pickup_time, status FROM orders WHERE id = ?').get(orderId);
  let n = null;
  const range = o && o.status !== 'cancelled' && o.pickup_date && o.pickup_time ? numberRange(o.pickup_time) : null;
  if (range) {
    const taken = new Set(db.prepare(`
      SELECT slot_number FROM orders
      WHERE pickup_date = ? AND slot_number BETWEEN ? AND ? AND status != 'cancelled' AND id != ?`)
      .all(o.pickup_date, range.first, range.last, o.id).map((r) => r.slot_number));
    for (let i = range.first; i <= range.last; i++) if (!taken.has(i)) { n = i; break; }
  }
  db.prepare('UPDATE orders SET slot_number = ? WHERE id = ?').run(n, orderId);
  return n;
}

/** Number any orders that don't have a pickup number yet (e.g. after upgrading), oldest first. */
function backfillSlotNumbers(db) {
  const ids = db.prepare(`
    SELECT id FROM orders WHERE slot_number IS NULL AND pickup_date IS NOT NULL AND pickup_time IS NOT NULL
      AND status != 'cancelled' ORDER BY id`).all();
  for (const { id } of ids) assignSlotNumber(db, id);
  return ids.length;
}

module.exports = { slotsFor, slotCount, slotStart, configure, assignSlotNumber, backfillSlotNumbers, numberRange };
