'use strict';

// Brings online orders from the Ecwid store behind the website (Duda "My e-Shop") into the database.
//
//  • Real store: set ECWID_STORE_ID and ECWID_TOKEN (an Ecwid API token with read_orders). The program
//    asks Ecwid every minute for orders changed since the last check (REST API v3).
//  • Demo: with no token, it reads fake orders — same shape as Ecwid's API — from
//    data/ecwid-demo-orders.json, which scripts/demo-ecwid-orders.js fills. Same code path otherwise.
//
// Orders are never added twice (import_key "ecwid:<id>"). If an order is paid or cancelled later in
// Ecwid, the program updates it.

const fs = require('node:fs');
const { transaction, getSetting, setSetting } = require('./db');
const { findOrCreateCustomer, insertOrder } = require('./orders');

const IMPORT = new Set(['PAID', 'AWAITING_PAYMENT']);          // pay-at-pickup orders are real orders too
const CANCELLED = new Set(['CANCELLED', 'REFUNDED']);

// Ecwid dates look like "2026-11-27 20:30:00 +0000".
function ecwidDate(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})?$/);
  if (!m) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
  const d = new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}${m[3]}:${m[4] || '00'}`);
  return Number.isNaN(d.getTime()) ? null : d;
}
// The shop computer's local date and time for a moment (pickup times are shown in local time).
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const utcStamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

const optionText = (o) => String(o.value ?? o.selections?.map((s) => s.selectionTitle).join(', ') ?? '').trim();

/** One Ecwid order item → our item. "Amount per package: 1.5lbs" × 2 packages → 3 lb at price per lb. */
function mapItem(it) {
  const opts = Array.isArray(it.selectedOptions) ? it.selectedOptions : [];
  let perPackageLb = null;
  const extras = [];
  for (const o of opts) {
    const text = optionText(o);
    if (!text) continue;
    const lb = text.match(/(\d+(?:\.\d+)?)\s*(lb|lbs|pound|pounds|#)\b/i) || text.match(/^(\d+(?:\.\d+)?)\s*(oz)\b/i);
    if (perPackageLb == null && lb && (o.type !== 'TEXT' || /amount|weight|size|package/i.test(o.name || ''))) {
      perPackageLb = lb[2].toLowerCase() === 'oz' ? Number(lb[1]) / 16 : Number(lb[1]);
      continue;
    }
    // Special Requests and any other choices become the cut instructions.
    extras.push(/special|request|instruction|note|cut/i.test(o.name || '') ? text : `${o.name}: ${text}`);
  }
  const packages = Number(it.quantity) || 1;
  const priceCents = Math.round(Number(it.price || 0) * 100);           // per package, options included
  const lineTotal = priceCents * packages;
  if (perPackageLb) {
    const lbs = Math.round(perPackageLb * packages * 1000) / 1000;
    const pkg = packages > 1 ? `${packages} × ${perPackageLb} lb packs` : '';
    return {
      productId: null, name: String(it.name || 'Item').slice(0, 200), unit: 'lb', quantity: lbs,
      unitPriceCents: Math.round(priceCents / perPackageLb), lineTotalCents: lineTotal,
      cut: [pkg, ...extras].filter(Boolean).join('; ').slice(0, 300),
    };
  }
  return {
    productId: null, name: String(it.name || 'Item').slice(0, 200), unit: 'each', quantity: packages,
    unitPriceCents: priceCents, lineTotalCents: lineTotal, cut: extras.join('; ').slice(0, 300),
  };
}

/** An Ecwid order → { customer, order } for our database. */
function mapOrder(e) {
  const bill = e.billingPerson || {};
  const ship = e.shippingPerson || {};
  const opt = e.shippingOption || {};
  const delivery = /DELIVERY|SHIPPING/i.test(opt.fulfillmentType || '') && !/PICKUP/i.test(opt.fulfillmentType || '');
  const pickup = ecwidDate(e.pickupTime);
  const created = ecwidDate(e.createDate) || (e.createTimestamp ? new Date(e.createTimestamp * 1000) : null);
  const address = delivery ? [ship.street, ship.city, [ship.stateOrProvinceCode, ship.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ') : '';
  const number = e.orderNumber ?? e.id;
  const notes = [e.orderComments, delivery && opt.shippingMethodName ? `Delivery: ${opt.shippingMethodName}` : ''].filter(Boolean).join('\n');
  const tx = String(e.externalTransactionId || '');
  return {
    customer: {
      name: bill.name || ship.name || e.email || 'Online customer',
      email: e.email || null,
      phone: bill.phone || ship.phone || null,
    },
    order: {
      status: 'new',
      fulfillment: delivery ? 'delivery' : 'pickup',
      pickupDate: pickup ? localDate(pickup) : null,
      pickupTime: pickup ? localTime(pickup) : null,
      deliveryAddress: address,
      notes: notes.slice(0, 1000),
      createdAt: created ? utcStamp(created) : null,
      source: 'online',
      // Stripe payment id (pi_…) lets the weighing screen refund through Stripe; otherwise the Ecwid number.
      orderRef: /^pi_/.test(tx) ? tx : `Ecwid ${number}`,
      importKey: `ecwid:${e.id}`,
      paymentStatus: e.paymentStatus === 'PAID' ? 'paid' : null,
      // Keep Ecwid's order number as ours when it's free, so it matches the My e-Shop app.
      id: /^\d{1,9}$/.test(String(e.orderNumber ?? '')) ? Number(e.orderNumber) : null,
      items: (e.items || []).map(mapItem),
    },
    ecwidNumber: number,
  };
}

function createEcwid({ db, storeId, token, demoFile, apiBase = 'https://app.ecwid.com', onOrder = () => {}, onChange = () => {}, log = console }) {
  const enabled = Boolean(storeId && token);
  const demo = !enabled && Boolean(demoFile);
  const status = { enabled, demo, store_id: storeId || null, lastSyncAt: null, lastError: null, imported: 0 };
  let timer = null;
  let running = null;

  async function fetchChanged(sinceUnix) {
    if (demo) {
      let all = [];
      try { all = JSON.parse(fs.readFileSync(demoFile, 'utf8')); } catch { /* no demo orders yet */ }
      return all.filter((o) => !sinceUnix || (o.updateTimestamp || o.createTimestamp || 0) >= sinceUnix);
    }
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const url = new URL(`/api/v3/${encodeURIComponent(storeId)}/orders`, apiBase);
      url.searchParams.set('limit', '100');
      url.searchParams.set('offset', String(offset));
      if (sinceUnix) url.searchParams.set('updatedFrom', String(sinceUnix));
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(res.status === 401 || res.status === 403
          ? 'Ecwid refused the token — check ECWID_STORE_ID and ECWID_TOKEN in .env (the token needs read_orders)'
          : body.errorMessage || `Ecwid returned ${res.status}`);
      }
      out.push(...(body.items || []));
      if (!body.items?.length || out.length >= (body.total ?? 0)) break;
    }
    return out;
  }

  /** Add a new Ecwid order, or update payment / cancellation of one we already have. Returns 'added' | 'updated' | null. */
  function ingest(e) {
    const key = `ecwid:${e.id}`;
    const existing = db.prepare('SELECT id, status, payment_status FROM orders WHERE import_key = ?').get(key);
    if (existing) {
      if (e.paymentStatus === 'PAID' && existing.payment_status !== 'paid') {
        db.prepare("UPDATE orders SET payment_status = 'paid' WHERE id = ?").run(existing.id);
        return 'updated';
      }
      if (CANCELLED.has(e.paymentStatus) && !['cancelled', 'picked_up'].includes(existing.status)) {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(existing.id);
        return 'updated';
      }
      return null;
    }
    if (!IMPORT.has(e.paymentStatus) || !e.items?.length) return null;     // incomplete checkouts, cancelled…
    const { customer, order } = mapOrder(e);
    const id = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM orders WHERE import_key = ?').get(key)) return null;
      const c = findOrCreateCustomer(db, customer, { refresh: true });
      const keepId = order.id && !db.prepare('SELECT 1 FROM orders WHERE id = ?').get(order.id) ? order.id : null;
      return insertOrder(db, { ...order, id: keepId, customerId: c.id });
    });
    if (!id) return null;
    status.imported++;
    onOrder({ id, name: customer.name, total_cents: order.items.reduce((s, i) => s + i.lineTotalCents, 0) });
    return 'added';
  }

  function sync() {
    if (!enabled && !demo) return Promise.resolve({ added: 0, updated: 0 });
    running ??= (async () => {
      try {
        const started = Math.floor(Date.now() / 1000);
        const last = Number(getSetting(db, demo ? 'ecwid_demo_last_sync' : 'ecwid_last_sync')) || 0;
        const firstDays = Number(process.env.ECWID_FIRST_SYNC_DAYS) || 2;
        const since = last ? last - 15 * 60 : (demo ? 0 : started - firstDays * 86400);
        let added = 0, updated = 0;
        for (const e of await fetchChanged(since)) {
          const r = ingest(e);
          if (r === 'added') added++;
          if (r === 'updated') { updated++; onChange(); }
        }
        setSetting(db, demo ? 'ecwid_demo_last_sync' : 'ecwid_last_sync', started);
        status.lastSyncAt = new Date().toISOString();
        status.lastError = null;
        return { added, updated };
      } catch (err) {
        status.lastError = err.message;
        log.error(`Ecwid sync failed: ${err.message}`);
        throw err;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function start(intervalMs) {
    if ((!enabled && !demo) || timer) return;
    const ms = intervalMs || (demo ? 4000 : (Number(process.env.ECWID_POLL_SECONDS) || 60) * 1000);
    sync().catch(() => {});
    timer = setInterval(() => sync().catch(() => {}), ms);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { status, sync, start, stop, ingest };
}

module.exports = { createEcwid, mapOrder, mapItem, ecwidDate };
