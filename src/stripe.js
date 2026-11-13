'use strict';

// Brings paid Stripe Checkout / Payment Link orders into the database.
//
// Two ways in, both safe to run together (an order is never added twice):
//  1. Polling: every minute, ask Stripe for recently completed checkouts. Works on a shop computer
//     with no hosting — only STRIPE_SECRET_KEY is needed.
//  2. Webhook: Stripe calls /api/stripe/webhook the moment someone pays. Instant, but the program
//     must be reachable on the internet. Needs STRIPE_WEBHOOK_SECRET as well.

const crypto = require('node:crypto');
const { transaction, getSetting, setSetting } = require('./db');
const { findOrCreateCustomer, insertOrder } = require('./orders');
const { toDate, parseTime } = require('./importer');

const PAID = new Set(['paid', 'no_payment_required']);

// ---------- Webhook signature (https://docs.stripe.com/webhooks#verify-manually) ----------
function verifySignature(rawBody, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.create(null);
  const sigs = [];
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=');
    if (k === 'v1') sigs.push(v); else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// ---------- Turning a Checkout Session into an order ----------
function fieldText(f) {
  if (f.type === 'dropdown') {
    const v = f.dropdown?.value;
    return f.dropdown?.options?.find((o) => o.value === v)?.label || v || '';
  }
  return String(f[f.type]?.value ?? '').trim();
}

// Free-text dates like "Dec 1" parse to year 2001 — move them to this (or next) year.
function pickupDate(text, now = new Date()) {
  const d = toDate(text);
  if (!d) return null;
  const year = now.getFullYear();
  if (Number(d.slice(0, 4)) >= year - 1) return d;
  let fixed = `${year}${d.slice(4)}`;
  if (new Date(fixed) < new Date(now.getTime() - 60 * 864e5)) fixed = `${year + 1}${d.slice(4)}`;
  return fixed;
}

function lineUnit(li) {
  const product = typeof li.price?.product === 'object' ? li.price.product : null;
  const meta = (product?.metadata?.unit || li.price?.metadata?.unit || '').toLowerCase();
  if (meta) return /lb|pound/.test(meta) ? 'lb' : 'each';
  const name = `${li.description || ''} ${product?.name || ''}`;
  return /(per|\/)\s*(lb|pound)|by the pound/i.test(name) ? 'lb' : 'each';
}

function formatAddress(a) {
  if (!a) return '';
  return [a.line1, a.line2, a.city, [a.state, a.postal_code].filter(Boolean).join(' '), a.country !== 'US' ? a.country : '']
    .filter(Boolean).join(', ');
}

/** Map a Stripe Checkout Session (+ its line items) to our order fields. */
function sessionToOrder(session, lineItems) {
  const cd = session.customer_details || {};
  const notes = [];
  let date = null, time = null;

  // Custom fields on the Checkout page (e.g. "Pickup date", "Pickup time", "Cutting instructions"),
  // plus metadata if the website adds its own.
  const fields = (session.custom_fields || []).map((f) => ({ label: f.label?.custom || f.key || '', value: fieldText(f) }));
  for (const [k, v] of Object.entries(session.metadata || {})) fields.push({ label: k, value: String(v) });
  for (const { label, value } of fields) {
    if (!value) continue;
    const l = label.toLowerCase();
    if (/time/.test(l) && !time && parseTime(value)) { time = parseTime(value); continue; }
    if (/pick|date|day|deliver/.test(l) && !date) {
      date = pickupDate(value.replace(/\b(at\s+)?\d{1,2}(:\d{2})?\s*[ap]\.?m\.?/i, '').trim());
      const tm = value.match(/\d{1,2}(:\d{2})?\s*[ap]\.?m\.?/i);
      if (!time && tm) time = parseTime(tm[0]);
      if (date) continue;
    }
    notes.push(`${label}: ${value}`);
  }

  const ship = session.collected_information?.shipping_details || session.shipping_details;
  const address = formatAddress(ship?.address);

  const items = lineItems.map((li) => {
    const quantity = li.quantity || 1;
    const lineTotal = li.amount_total ?? li.amount_subtotal ?? (li.price?.unit_amount || 0) * quantity;
    const product = typeof li.price?.product === 'object' ? li.price.product : null;
    return {
      productId: null,
      name: String(li.description || product?.name || 'Item').slice(0, 200),
      unit: lineUnit(li),
      quantity,
      unitPriceCents: li.price?.unit_amount ?? Math.round(lineTotal / quantity),
      lineTotalCents: lineTotal,
      cut: product?.metadata?.cut_instructions || '',
    };
  });

  return {
    customer: { name: cd.name || ship?.name || cd.email || 'Online customer', email: cd.email || null, phone: cd.phone || null },
    order: {
      status: 'new',
      fulfillment: address ? 'delivery' : 'pickup',
      pickupDate: date,
      pickupTime: time,
      deliveryAddress: address,
      notes: notes.join('\n').slice(0, 1000),
      createdAt: session.created ? new Date(session.created * 1000).toISOString().slice(0, 19).replace('T', ' ') : null,
      source: 'online',
      orderRef: session.payment_intent && typeof session.payment_intent === 'string' ? session.payment_intent : session.id,
      importKey: `stripe:${session.id}`,
      paymentStatus: 'paid',
      items,
    },
  };
}

// ---------- Talking to Stripe ----------
function createStripe({ db, secretKey, webhookSecret, apiBase = 'https://api.stripe.com', onOrder = () => {}, log = console }) {
  const enabled = Boolean(secretKey);
  const status = { enabled, webhook: Boolean(webhookSecret), lastSyncAt: null, lastError: null, imported: 0 };
  let timer = null;
  let running = null;

  async function api(path, params = {}) {
    const url = new URL(path, apiBase);
    for (const [k, v] of Object.entries(params)) {
      for (const val of [].concat(v)) url.searchParams.append(k, val);
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-06-20' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error?.message || `Stripe returned ${res.status}`;
      throw new Error(res.status === 401 ? 'Stripe rejected the API key — check STRIPE_SECRET_KEY in .env' : msg);
    }
    return body;
  }

  async function lineItemsFor(sessionId) {
    const items = [];
    let starting_after;
    do {
      const page = await api(`/v1/checkout/sessions/${sessionId}/line_items`, {
        limit: 100, 'expand[]': 'data.price.product', ...(starting_after ? { starting_after } : {}),
      });
      items.push(...page.data);
      starting_after = page.has_more ? page.data.at(-1).id : null;
    } while (starting_after);
    return items;
  }

  /** Add one completed Checkout Session as an order. Returns the new order id, or null if skipped. */
  async function ingestSession(session) {
    if (session.object !== 'checkout.session' || session.status === 'expired') return null;
    if (!PAID.has(session.payment_status)) return null;           // e.g. bank transfer still pending
    const key = `stripe:${session.id}`;
    if (db.prepare('SELECT 1 FROM orders WHERE import_key = ?').get(key)) return null;

    const lineItems = session.line_items?.data && !session.line_items.has_more
      ? session.line_items.data : await lineItemsFor(session.id);
    if (!lineItems.length) return null;
    const { customer, order } = sessionToOrder(session, lineItems);

    const id = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM orders WHERE import_key = ?').get(key)) return null; // raced with the webhook
      const c = findOrCreateCustomer(db, customer, { refresh: true });
      return insertOrder(db, { ...order, customerId: c.id });
    });
    if (id) {
      status.imported++;
      onOrder({ id, name: customer.name, total_cents: order.items.reduce((s, i) => s + i.lineTotalCents, 0) });
    }
    return id;
  }

  /** Fetch recently completed checkouts and add any we don't have yet. */
  function sync() {
    if (!enabled) return Promise.resolve({ added: 0 });
    running ??= (async () => {
      try {
        const last = Number(getSetting(db, 'stripe_last_sync')) || 0;
        const firstDays = Number(process.env.STRIPE_FIRST_SYNC_DAYS) || 2;
        const since = last ? last - 15 * 60 : Math.floor(Date.now() / 1000) - firstDays * 86400; // overlap to be safe
        const started = Math.floor(Date.now() / 1000);
        let added = 0, starting_after;
        do {
          const page = await api('/v1/checkout/sessions', {
            status: 'complete', 'created[gte]': since, limit: 100, ...(starting_after ? { starting_after } : {}),
          });
          for (const s of page.data) if (await ingestSession(s)) added++;
          starting_after = page.has_more ? page.data.at(-1).id : null;
        } while (starting_after);
        setSetting(db, 'stripe_last_sync', started);
        status.lastSyncAt = new Date().toISOString();
        status.lastError = null;
        return { added };
      } catch (err) {
        status.lastError = err.message;
        log.error(`Stripe sync failed: ${err.message}`);
        throw err;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function start(intervalMs = (Number(process.env.STRIPE_POLL_SECONDS) || 60) * 1000) {
    if (!enabled || timer) return;
    sync().catch(() => {});
    timer = setInterval(() => sync().catch(() => {}), intervalMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  /** Express handler for POST /api/stripe/webhook (needs the raw body). */
  async function webhook(req, res) {
    if (!webhookSecret) return res.status(404).json({ error: 'Stripe webhook not configured' });
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySignature(raw, req.headers['stripe-signature'], webhookSecret)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    let event;
    try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      try {
        await ingestSession(event.data.object);
      } catch (err) {
        log.error(`Stripe webhook: could not add order: ${err.message}`);
        return res.status(500).json({ error: 'Could not record order' });   // Stripe will retry
      }
    }
    res.json({ received: true });
  }

  return { status, sync, start, stop, webhook, ingestSession };
}

module.exports = { createStripe, verifySignature, sessionToOrder, parseTime, pickupDate };
