'use strict';

// Half-hour (or other length) pickup slots and how full each one is on a given day.

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const slotStart = (time, step) => hhmm(Math.floor(toMin(time) / step) * step);

/** Every slot of the day with its order count. Cancelled orders don't count. */
function slotsFor(db, date, { open, close, slot_minutes: step, slot_max: max }) {
  const orders = db.prepare(`
    SELECT o.id, o.customer_id, o.pickup_time, o.status, o.source, o.payment_status, c.name AS customer_name,
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

module.exports = { slotsFor, slotCount, slotStart };
