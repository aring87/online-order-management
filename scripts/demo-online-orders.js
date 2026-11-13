'use strict';

// DEMO: pretends to be customers ordering on the website, so you can watch online orders
// arrive in the program live (pop-up, unread count, NEW ribbon, prep board).
// The program must be running. All people, emails and phone numbers are FAKE.
//
//   npm run demo-online-orders                      → 3 orders now, then 1 every ~20s (10 total)
//   node scripts/demo-online-orders.js --count 20 --now 5 --every 10
//   node scripts/demo-online-orders.js --port 3000
//
// Stop any time with Ctrl+C.

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const PORT = Number(args.port || process.env.PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;
const COUNT = Number(args.count || 10);
const NOW = Math.min(Number(args.now ?? 3), COUNT);
const EVERY = Number(args.every || 20);

// A mix of brand-new online customers and a few from the sample Excel file
// (so their history shows imported orders and the new online order together).
const PEOPLE = [
  ['Olivia Grant', 'olivia.grant@example.com', '555-010-0201'],
  ['Marcus Bell', 'marcus.bell@example.com', '555-010-0202'],
  ['Grace Yamamoto', 'grace.y@example.com', '555-010-0203'],
  ['Luis Romero', 'luis.romero@example.com', '555-010-0204'],
  ['Chloe Dubois', 'chloe.dubois@example.com', '555-010-0205'],
  ['Ben Archer', 'ben.archer@example.com', '555-010-0206'],
  ['Fatima Khan', 'fatima.khan@example.com', '555-010-0207'],
  ['Owen Fischer', 'owen.fischer@example.com', '555-010-0208'],
  ['Tom Becker', 'tom.becker@example.com', '(555) 010-0101'],
  ['Priya Nair', 'priya.nair@example.com', '555-010-0104'],
  ['Maureen Kelly', 'mo.kelly@example.com', '555-010-0106'],
  ['Rosa Alvarez', 'rosa.alvarez@example.com', '555-010-0108'],
];
const CUTS = {
  'Ribeye Steak': ['1" thick', '1.25" thick', '1.5" thick, 2 steaks'],
  'New York Strip': ['1" thick', 'trim the fat cap'],
  'Filet Mignon': ['2" thick', 'center cut please'],
  'Ground Beef (80/20)': ['1 lb packs', '2 lb packs'],
  'Beef Brisket': ['whole packer', 'flat only', 'trimmed for smoking'],
  'Chuck Roast': ['tied'],
  'Short Ribs': ['English cut', 'flanken cut'],
  'Pork Chops (bone-in)': ['1" thick', 'thin cut'],
  'Pork Shoulder': ['bone-in', 'boneless, tied'],
  'Baby Back Ribs': ['membrane removed'],
  'Italian Sausage': ['hot', 'mild'],
  'Whole Chicken': ['spatchcock', 'cut in 8'],
  'Chicken Breast (boneless)': ['butterflied'],
  'Lamb Chops': ['frenched'],
  'Leg of Lamb': ['butterflied', 'bone-in'],
};
const NOTES = ['', '', '', 'Please call when ready', 'Picking up on my lunch break', 'For a birthday dinner',
  'Can you vacuum seal?', 'First time ordering online!'];
const TIMES = ['09:30', '10:00', '11:00', '12:00', '12:30', '14:00', '15:00', '16:00', '16:30', '17:00'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const isoDay = (offset) => {
  const d = new Date(Date.now() + offset * 864e5);
  return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeOrder(products) {
  const [name, email, phone] = pick(PEOPLE);
  const chosen = new Map();
  const n = between(1, 4);
  while (chosen.size < n) {
    const p = pick(products);
    const quantity = p.unit === 'lb' ? between(2, 12) / 2 : between(1, 3);
    chosen.set(p.id, {
      product_id: p.id,
      quantity,
      cut_instructions: CUTS[p.name] && Math.random() < 0.6 ? pick(CUTS[p.name]) : '',
    });
  }
  return {
    name, email, phone,
    fulfillment: 'pickup',
    pickup_date: isoDay(between(0, 4)),
    pickup_time: Math.random() < 0.8 ? pick(TIMES) : '',
    notes: pick(NOTES),
    items: [...chosen.values()],
  };
}

async function main() {
  let products;
  try {
    products = await (await fetch(`${BASE}/api/products`)).json();
  } catch {
    console.error(`\n  Can't reach the orders program at ${BASE}.`);
    console.error('  Start the program first (desktop icon or start-windows.bat), then run this again.\n');
    process.exit(1);
  }
  console.log(`\n  DEMO: sending ${COUNT} fake online orders to ${BASE}`);
  console.log(`  ${NOW} right away, then one about every ${EVERY} seconds. Watch the "Online orders" tab.`);
  console.log('  Press Ctrl+C to stop.\n');

  for (let i = 0; i < COUNT; i++) {
    if (i >= NOW) await sleep((EVERY * (0.6 + Math.random() * 0.8)) * 1000);
    const order = makeOrder(products);
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`  ✗ order failed: ${data.error || res.status}`); continue; }
    const items = data.items.map((it) => `${it.quantity}${it.unit === 'lb' ? ' lb' : ''} ${it.product_name}`).join(', ');
    console.log(`  ✓ #${data.id}  ${order.name.padEnd(16)} ${items}  ($${(data.total_cents / 100).toFixed(2)})`);
  }
  console.log('\n  Done. (These are fake: delete them in the program, or delete the data folder to start over.)\n');
}

main();
