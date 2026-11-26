'use strict';

// DEMO: pretends to be the website's Ecwid store ("My e-Shop") receiving online orders.
// Writes FAKE orders — in the same shape Ecwid's API returns them — to data/ecwid-demo-orders.json.
// The running program (with no ECWID_TOKEN set) reads that file every few seconds through the
// same code it will use for the real store, so the orders appear on the Online orders tab.
//
//   npm run demo-ecwid-orders                    → 3 orders now, then 1 every ~20s (10 total)
//   node scripts/demo-ecwid-orders.js --count 15 --now 5 --every 10
//   node scripts/demo-ecwid-orders.js --clear     → remove the demo orders file
//
// All customers, payments and order numbers are made up. Nothing is sent anywhere.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch { /* no .env */ }
const DB_FILE = process.env.DB_FILE || env.DB_FILE || path.join(ROOT, 'data', 'orders.db');
const FILE = path.join(path.dirname(DB_FILE), 'ecwid-demo-orders.json');
const COUNT = Number(args.count || 10);
const NOW = Math.min(Number(args.now ?? 3), COUNT);
const EVERY = Number(args.every || 20);

// Products like the website's: [name, price per lb (or each), package sizes in lb (empty = sold each), special requests]
const PRODUCTS = [
  ['Ground Chuck 85/15', 7.49, [1, 1.5, 2, 3], ['', '', 'Frozen 1 lb packs please', 'Fresh, not frozen']],
  ['Ground Round 90/10', 8.49, [1, 1.5, 2], ['', 'Frozen please']],
  ['Ground Sirloin 95/5', 9.99, [1, 2], ['']],
  ['Ground Chuck Patties 85/15 (box of 8)', 15.99, [], ['']],
  ['Ribeye Steak', 24.99, [1, 1.5, 2, 3], ['1" thick', '1.5" thick, 2 steaks', 'Bone-in please', '']],
  ['NY Strip Steak', 21.99, [1, 2], ['1.25" thick', '']],
  ['Filet Mignon', 34.99, [0.5, 1, 2], ['2" thick', 'Center cut', '']],
  ['Beef Brisket', 8.99, [5, 8, 12], ['Whole packer', 'Flat only', 'Trimmed for smoking']],
  ['Prime Rib Roast', 22.99, [4, 6, 8], ['Frenched & tied', 'Boneless', '']],
  ['Pork Chops (bone-in)', 6.99, [1, 2], ['1" thick', 'Thin cut', '']],
  ['Thick-Cut Bacon', 9.99, [1, 2], ['']],
  ['Italian Sausage', 7.49, [1, 2], ['Hot', 'Mild']],
  ['Whole Chicken', 14.99, [], ['Spatchcock', 'Cut in 8', '']],
  ['Lamb Chops', 22.99, [1, 2], ['Frenched', '']],
  ['Atlantic Salmon Fillet', 16.99, [1, 1.5, 2], ['Skin off', '']],
];
const PEOPLE = [
  ['Megan Foster', 'megan.foster@example.com', '555-010-0701'],
  ['Andre Lewis', 'andre.lewis@example.com', '555-010-0702'],
  ['Tina Morales', 'tina.morales@example.com', '555-010-0703'],
  ['Greg Adams', 'greg.adams@example.com', '555-010-0704'],
  ['Hye-jin Park', 'hyejin.park@example.com', '555-010-0705'],
  ['Robert Kim', 'robert.kim@example.com', '555-010-0706'],
  ['Laura Bennett', 'laura.bennett@example.com', '555-010-0707'],
  ['Tom Becker', 'tom.becker@example.com', '(555) 010-0101'],      // also in the sample spreadsheet
  ['Rosa Alvarez', 'rosa.alvarez@example.com', '555-010-0108'],    // also in the sample spreadsheet
];
const COMMENTS = ['', '', '', 'Please call when ready', 'Picking up after work', 'For a family BBQ'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => Math.round(n * 100) / 100;
// Ecwid writes dates in UTC like "2026-11-27 20:30:00 +0000"
const ecwidStamp = (d) => `${d.toISOString().slice(0, 19).replace('T', ' ')} +0000`;

const deck = [];
const nextPerson = () => { if (!deck.length) deck.push(...[...PEOPLE].sort(() => Math.random() - 0.5)); return deck.pop(); };

// A pickup time the shop actually offers: not Monday, Sundays until 3 PM, half-hour slots 10 AM-6 PM.
function pickupMoment() {
  for (;;) {
    const d = new Date();
    d.setDate(d.getDate() + between(1, 5));
    const dow = d.getDay();
    if (dow === 1) continue;
    const lastSlot = dow === 0 ? 14.5 : 17.5;
    const t = 10 + between(0, (lastSlot - 10) * 2) / 2;
    d.setHours(Math.floor(t), (t % 1) * 60, 0, 0);
    return d;
  }
}

function fakeEcwidOrder(number) {
  const [name, email, phone] = nextPerson();
  const items = [];
  const used = new Set();
  const n = between(1, 3);
  while (items.length < n) {
    const [pname, perLb, sizes, requests] = pick(PRODUCTS);
    if (used.has(pname)) continue;
    used.add(pname);
    const options = [];
    let price = perLb;
    if (sizes.length) {
      const size = pick(sizes);
      price = money(perLb * size);
      options.push({ name: 'Amount per package', type: 'CHOICE', value: `${size}lbs`,
        selections: [{ selectionTitle: `${size}lbs`, selectionModifier: money(price - perLb), selectionModifierType: 'ABSOLUTE' }] });
    }
    const req = pick(requests);
    if (req) options.push({ name: 'Special Requests', type: 'TEXT', value: req });
    const quantity = sizes.length ? between(1, 2) : between(1, 2);
    items.push({ id: between(100000, 999999), productId: between(100000000, 999999999), name: pname, quantity, price,
      sku: `00${between(100, 999)}`, selectedOptions: options });
  }
  const subtotal = money(items.reduce((s, i) => s + i.price * i.quantity, 0));
  const tax = money(subtotal * 0.01);
  const delivery = Math.random() < 0.15;
  const paid = Math.random() < 0.85;
  const when = pickupMoment();
  const now = new Date();
  return {
    id: `DEMO${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    internalId: between(100000000, 999999999),
    orderNumber: number,
    email,
    paymentStatus: paid ? 'PAID' : 'AWAITING_PAYMENT',
    paymentMethod: paid ? 'Credit or debit card' : 'Pay at pickup',
    paymentModule: paid ? 'Stripe' : 'CUSTOM_PAYMENT',
    externalTransactionId: paid ? `pi_demo${crypto.randomBytes(8).toString('hex')}` : '',
    fulfillmentStatus: 'AWAITING_PROCESSING',
    subtotal, tax, total: money(subtotal + tax),
    createDate: ecwidStamp(now),
    createTimestamp: Math.floor(now / 1000),
    updateTimestamp: Math.floor(now / 1000),
    billingPerson: { name, phone },
    shippingPerson: delivery
      ? { name, phone, street: `${between(10, 999)} Maple Ave`, city: 'Springfield', stateOrProvinceCode: 'VA', postalCode: '22150', countryCode: 'US' }
      : { name, phone },
    shippingOption: delivery
      ? { shippingMethodName: 'Local delivery', fulfillmentType: 'DELIVERY', shippingRate: 5 }
      : { shippingMethodName: 'Pickup', fulfillmentType: 'PICKUP', shippingRate: 0 },
    pickupTime: ecwidStamp(when),
    orderComments: [pick(COMMENTS), 'DEMO order'].filter(Boolean).join(' · '),
    items,
  };
}

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function writeAll(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, FILE);              // never leave a half-written file for the program to read
}

async function main() {
  if (args.clear) {
    try { fs.unlinkSync(FILE); } catch { /* already gone */ }
    console.log('\n  Demo Ecwid orders file removed. (Orders already in the program stay until you delete them.)\n');
    return;
  }
  console.log(`\n  DEMO: adding ${COUNT} fake Ecwid store orders (as if placed on the website).`);
  console.log(`  ${NOW} right away, then one about every ${EVERY} seconds. Watch the "Online orders" tab.`);
  console.log('  The program must be running with no ECWID_TOKEN set. Press Ctrl+C to stop.\n');
  for (let i = 0; i < COUNT; i++) {
    if (i >= NOW) await sleep(EVERY * (0.6 + Math.random() * 0.8) * 1000);
    const list = readAll();
    const number = Math.max(20000, ...list.map((o) => o.orderNumber || 0)) + 1;
    const o = fakeEcwidOrder(number);
    list.push(o);
    writeAll(list);
    const items = o.items.map((it) => `${it.quantity} × ${it.name}${it.selectedOptions[0]?.name === 'Amount per package' ? ` (${it.selectedOptions[0].value})` : ''}`).join(', ');
    console.log(`  ✓ Ecwid #${o.orderNumber}  ${o.paymentStatus === 'PAID' ? 'paid  ' : 'unpaid'}  $${o.total.toFixed(2).padStart(7)}  ${o.billingPerson.name.padEnd(14)} ${items}`);
  }
  console.log('\n  Done. They appear in the program within a few seconds. These are fake (marked "DEMO order").\n');
}

main();
