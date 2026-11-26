'use strict';

// Weighed pricing: customers pay for an estimated weight; once each item is cut and weighed the
// price is worked out again at the same price per lb, and the difference is settled
// (Stripe refund, a Stripe payment link for the extra, collected at the counter, or waived).

/** Weighing summary for an order (adds `weigh` to it). Needs order.items. */
function weighSummary(db, order) {
  const adjustments = db.prepare('SELECT * FROM adjustments WHERE order_id = ? ORDER BY id').all(order.id);
  const estimated = order.items.reduce((s, i) => s + i.line_total_cents, 0);
  const actual = order.items.reduce((s, i) => s + (i.actual_line_total_cents ?? i.line_total_cents), 0);
  const toWeigh = order.items.filter((i) => i.unit === 'lb');
  const weighed = toWeigh.filter((i) => i.actual_quantity != null).length;
  const difference = actual - estimated;          // + customer owes more, − customer is owed money back
  const done = adjustments.filter((a) => a.status === 'done');
  const settled = done.reduce((s, a) => s + (a.kind === 'refund' ? -a.amount_cents : a.kind === 'waive' ? 0 : a.amount_cents), 0);
  const waived = done.some((a) => a.kind === 'waive');
  const outstanding = waived ? 0 : difference - settled;
  order.weigh = {
    estimated_cents: estimated,
    actual_cents: actual,
    difference_cents: difference,
    outstanding_cents: outstanding,
    items_to_weigh: toWeigh.length,
    items_weighed: weighed,
    all_weighed: toWeigh.length > 0 ? weighed === toWeigh.length : order.items.some((i) => i.actual_quantity != null),
    paid_online: order.payment_status === 'paid',
    can_refund_in_stripe: order.payment_status === 'paid' && /^pi_/.test(order.order_ref || ''),
    pending_link: adjustments.find((a) => a.kind === 'charge' && a.status === 'pending') || null,
    adjustments,
  };
  return order;
}

/** Record the actual weight (or count) of one item and reprice it. null clears it. */
function setActualWeight(db, itemId, value) {
  const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId);
  if (!item) return null;
  if (value == null || value === '') {
    db.prepare('UPDATE order_items SET actual_quantity = NULL, actual_line_total_cents = NULL WHERE id = ?').run(itemId);
  } else {
    const q = Math.round(Number(value) * 1000) / 1000;
    if (!Number.isFinite(q) || q < 0 || q > 10000) throw new Error('Invalid weight');
    db.prepare('UPDATE order_items SET actual_quantity = ?, actual_line_total_cents = ? WHERE id = ?')
      .run(q, Math.round(q * item.unit_price_cents), itemId);
  }
  return item.order_id;
}

module.exports = { weighSummary, setActualWeight };
