'use strict';

// Item totals: how much of each item (and each cut of it) is on the orders in a period.
// Used for the day-before prep list (by pickup date) and for sales (by order date).

const CATEGORY_ORDER = ['Beef', 'Pork', 'Poultry', 'Lamb', 'Other'];

// Guess the meat for items that aren't in the product list (imported, Stripe, typed in).
function guessCategory(name) {
  const n = name.toLowerCase();
  if (/lamb|mutton/.test(n)) return 'Lamb';
  if (/chicken|turkey|duck|hen|poultry|wing|drumstick/.test(n)) return 'Poultry';
  if (/pork|bacon|ham\b|sausage|baby back|spare rib|chorizo|bratwurst|prosciutto|tenderloin.*pork/.test(n)) return 'Pork';
  if (/beef|steak|ribeye|rib eye|strip|sirloin|filet|brisket|chuck|short rib|prime rib|tenderloin|roast|burger|ground|jerky|t-bone|porterhouse|flank|skirt|tri-tip|oxtail|veal/.test(n)) return 'Beef';
  return 'Other';
}

// "Ribeye Steak (per lb)", "Ribeye steak /lb" and "ribeye steak" are the same thing.
function cleanName(name) {
  return String(name || '').replace(/\s*[(-]?\s*(per|\/)\s*(lb|pound)\s*\)?\s*$/i, '').replace(/\s+/g, ' ').trim();
}
const cleanCut = (cut) => String(cut || '').replace(/\s+/g, ' ').trim();

/**
 * @param basis 'pickup' (prep list) or 'order' (sales)
 * @param show  'all' (everything except cancelled), 'open' (not picked up yet), 'done' (picked up)
 * @param source '' (all), 'online', 'store' (staff-entered + imported), 'manual', 'import'
 */
function itemTotals(db, { basis = 'pickup', from, to, show = 'all', source = '' } = {}) {
  const where = ["o.status != 'cancelled'"];
  const params = [];
  const dateCol = basis === 'order' ? "date(o.created_at, 'localtime')" : 'o.pickup_date';
  if (from) { where.push(`${dateCol} >= ?`); params.push(from); }
  if (to) { where.push(`${dateCol} <= ?`); params.push(to); }
  if (show === 'open') where.push("o.status IN ('new', 'preparing', 'ready')");
  if (show === 'done') where.push("o.status = 'picked_up'");
  if (source === 'store') where.push("o.source IN ('manual', 'import')");
  else if (['online', 'manual', 'import'].includes(source)) { where.push('o.source = ?'); params.push(source); }

  const rows = db.prepare(`
    SELECT i.product_name, i.unit, i.quantity, i.line_total_cents, i.cut_instructions, i.packed, i.order_id,
           p.category
    FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN products p ON p.id = i.product_id
    WHERE ${where.join(' AND ')}`).all(...params);

  const items = new Map();
  const orderIds = new Set();
  const round = (n) => Math.round(n * 100) / 100;
  for (const r of rows) {
    orderIds.add(r.order_id);
    const name = cleanName(r.product_name);
    const key = name.toLowerCase();
    if (!items.has(key)) {
      items.set(key, { name, category: r.category || guessCategory(name), lb: 0, each: 0, revenue_cents: 0,
        lines: 0, packed_lines: 0, orders: new Set(), cuts: new Map() });
    }
    const it = items.get(key);
    const unitKey = r.unit === 'lb' ? 'lb' : 'each';
    it[unitKey] += r.quantity;
    it.revenue_cents += r.line_total_cents;
    it.lines++;
    if (r.packed) it.packed_lines++;
    it.orders.add(r.order_id);

    const cut = cleanCut(r.cut_instructions);
    const ck = cut.toLowerCase();
    if (!it.cuts.has(ck)) it.cuts.set(ck, { cut, lb: 0, each: 0, orders: new Set() });
    const c = it.cuts.get(ck);
    c[unitKey] += r.quantity;
    c.orders.add(r.order_id);
  }

  const list = [...items.values()].map((it) => ({
    name: it.name,
    category: it.category,
    lb: round(it.lb),
    each: round(it.each),
    revenue_cents: it.revenue_cents,
    orders: it.orders.size,
    lines: it.lines,
    packed_lines: it.packed_lines,
    // Special cuts first (most needed first), "no special cut" last.
    cuts: [...it.cuts.values()]
      .map((c) => ({ cut: c.cut, lb: round(c.lb), each: round(c.each), orders: c.orders.size }))
      .sort((a, b) => (!a.cut - !b.cut) || (b.lb + b.each) - (a.lb + a.each)),
  })).sort((a, b) => (CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    items: list,
    totals: {
      lb: round(list.reduce((s, i) => s + i.lb, 0)),
      each: round(list.reduce((s, i) => s + i.each, 0)),
      revenue_cents: list.reduce((s, i) => s + i.revenue_cents, 0),
      orders: orderIds.size,
      items: list.length,
    },
  };
}

module.exports = { itemTotals, guessCategory, cleanName };
