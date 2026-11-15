'use strict';

// DEMO: pretends to be Stripe telling the program "a customer just paid" — the exact signed
// `checkout.session.completed` notice Stripe sends for a Payment Link / Checkout payment.
// The program processes it with the same code it will use for real Stripe orders
// (signature check → customer → items → pickup date/time & cut instructions → "💳 Paid").
//
// Works only while NO real Stripe key is set up (the program then keeps a local demo secret in
// the data folder). All customers, cards and payments here are FAKE — no money moves.
//
//   npm run demo-stripe-orders                     → 2 orders now, then 1 every ~20s (8 total)
//   node scripts/demo-stripe-orders.js --count 12 --now 3 --every 10 --port 3000

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));

// Settings from .env (PORT, DB_FILE), like the program itself.
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch { /* no .env */ }
const PORT = Number(args.port || process.env.PORT || env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || env.DB_FILE || path.join(ROOT, 'data', 'orders.db');
const SECRET_FILE = path.join(path.dirname(DB_FILE), '.stripe-demo-secret');
const COUNT = Number(args.count || 8);
const NOW = Math.min(Number(args.now ?? 2), COUNT);
const EVERY = Number(args.every || 20);

// What a butcher's Stripe products might look like (prices in cents).
const PRODUCTS = [
  ['Ribeye Steak (per lb)', 2499, ['1" thick', '1.5" thick', 'bone-in please']],
  ['NY Strip (per lb)', 2199, ['1" thick', '']],
  ['Beef Brisket (per lb)', 899, ['whole packer', 'flat only', 'trimmed for smoking']],
  ['Ground Beef 80/20 (per lb)', 699, ['1 lb packs', '']],
  ['Prime Rib Roast (per lb)', 2299, ['frenched & tied', 'boneless']],
  ['Pork Shoulder (per lb)', 499, ['bone-in', 'boneless, tied']],
  ['Thick-Cut Bacon (per lb)', 999, ['']],
  ['Whole Chicken', 1499, ['spatchcock', 'cut in 8']],
  ['Lamb Chops (per lb)', 2299, ['frenched']],
  ['Butcher\'s Steak Box (6 steaks)', 8999, ['']],
  ['Fresh Turkey (12-14 lb)', 4999, ['brined', '']],
];
const PEOPLE = [
  ['Natalie Brooks', 'natalie.brooks@example.com', '+1 555 010 0301'],
  ['Derek Simmons', 'derek.simmons@example.com', '+1 555 010 0302'],
  ['Aisha Rahman', 'aisha.rahman@example.com', '+1 555 010 0303'],
  ['Connor Walsh', 'connor.walsh@example.com', '+1 555 010 0304'],
  ['Lena Kowalczyk', 'lena.k@example.com', '+1 555 010 0305'],
  ['Victor Huang', 'victor.huang@example.com', '+1 555 010 0306'],
  ['Jenny Liu', 'jenny.liu@example.com', '+1 555 010 0112'],           // also in the sample spreadsheet
  ['Dave Kowalski', 'dkowalski@example.com', '+1 555 010 0109'],       // also in the sample spreadsheet
];
const TIMES = ['9:00 AM', '10:30 AM', '12:00 PM', '1:30 PM', '3:00 PM', '4:30 PM', '5:00 PM'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (prefix) => `${prefix}_test_demo${crypto.randomBytes(8).toString('hex')}`;

// Customers type dates in all sorts of ways on a Stripe text field.
function typedDate() {
  const d = new Date(Date.now() + between(1, 6) * 864e5);
  return pick([
    `${d.getMonth() + 1}/${d.getDate()}`,
    d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
  ]);
}

// Go through the customers in a shuffled order so the demo doesn't repeat the same person.
const deck = [];
function nextPerson() {
  if (!deck.length) deck.push(...[...PEOPLE].sort(() => Math.random() - 0.5));
  return deck.pop();
}

function fakeCheckoutSession() {
  const [name, email, phone] = nextPerson();
  const chosen = new Map();
  const n = between(1, 3);
  while (chosen.size < n) {
    const [pname, price, cuts] = pick(PRODUCTS);
    const quantity = /per lb/.test(pname) ? between(1, 6) : between(1, 2);    // Stripe quantities are whole numbers
    chosen.set(pname, {
      id: rid('li'), object: 'item', description: pname, quantity,
      amount_subtotal: price * quantity, amount_total: price * quantity, currency: 'usd',
      price: { id: rid('price'), object: 'price', unit_amount: price, currency: 'usd',
        product: { id: rid('prod'), object: 'product', name: pname, metadata: {} } },
      _cut: pick(cuts),
    });
  }
  const items = [...chosen.values()];
  const cutText = items.filter((i) => i._cut).map((i) => `${i.description.replace(/ \(per lb\)/, '')}: ${i._cut}`).join('; ');
  items.forEach((i) => delete i._cut);
  const total = items.reduce((s, i) => s + i.amount_total, 0);
  const text = (key, label, value) => ({ key, label: { type: 'custom', custom: label }, type: 'text', optional: true, text: { value } });

  return {
    id: rid('cs'), object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
    created: Math.floor(Date.now() / 1000), currency: 'usd', amount_subtotal: total, amount_total: total,
    payment_intent: rid('pi'), payment_link: 'plink_test_demo',
    customer_details: { name, email, phone, address: { country: 'US', postal_code: '62701' } },
    custom_fields: [
      text('pickupdate', 'Pickup date', typedDate()),
      { key: 'pickuptime', label: { type: 'custom', custom: 'Pickup time' }, type: 'dropdown', optional: true,
        dropdown: { value: 't', options: [{ label: pick(TIMES), value: 't' }] } },
      text('cuttinginstructions', 'Cutting instructions', cutText),
    ],
    metadata: { Note: 'DEMO - fake Stripe test payment' },
    line_items: { object: 'list', data: items, has_more: false },
  };
}

function signedRequest(body, secret) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` };
}

async function main() {
  let secret;
  try { secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch { /* handled below */ }
  try { await fetch(`http://127.0.0.1:${PORT}/api/products`); } catch {
    console.error(`\n  Can't reach the orders program on port ${PORT}. Start the program first, then run this again.\n`);
    process.exit(1);
  }
  if (!secret) {
    console.error('\n  The Stripe demo isn\'t available.');
    console.error('  It only works while no real Stripe key is set up. Restart the program once after updating,');
    console.error('  and make sure STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are not set in .env.\n');
    process.exit(1);
  }

  console.log(`\n  DEMO: sending ${COUNT} fake PAID Stripe orders to the program (port ${PORT}).`);
  console.log(`  ${NOW} right away, then one about every ${EVERY} seconds. Watch the "Online orders" tab.`);
  console.log('  Nothing is charged — these are made up. Press Ctrl+C to stop.\n');

  for (let i = 0; i < COUNT; i++) {
    if (i >= NOW) await sleep(EVERY * (0.6 + Math.random() * 0.8) * 1000);
    const session = fakeCheckoutSession();
    const body = JSON.stringify({
      id: rid('evt'), object: 'event', type: 'checkout.session.completed', livemode: false,
      created: session.created, data: { object: session },
    });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stripe/webhook`, { method: 'POST', headers: signedRequest(body, secret), body });
    if (res.status === 404) {
      console.error('  The program isn\'t accepting demo Stripe orders — restart it once after updating, then try again.');
      process.exit(1);
    }
    if (!res.ok) { console.error(`  ✗ not accepted (${res.status}): ${(await res.json().catch(() => ({}))).error || ''}`); continue; }
    const items = session.line_items.data.map((li) => `${li.quantity} × ${li.description}`).join(', ');
    console.log(`  ✓ paid  $${(session.amount_total / 100).toFixed(2).padStart(7)}  ${session.customer_details.name.padEnd(15)} ${items}`);
  }
  console.log('\n  Done. These orders are fake (marked "DEMO" in their notes) — delete them in the program,');
  console.log('  or delete the data folder to start over.\n');
}

main();
