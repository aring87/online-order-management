'use strict';

// Makes samples/sample-orders.xlsx: FAKE butcher orders for trying out "Import from Excel".
// Laid out like a hand-kept order log (title row, an order spread over several rows with the
// customer only on the first line, mixed phone formats…) so the importer gets a realistic workout.
//
//   npm run sample-data            → dates around today
//   node scripts/make-sample-data.js 2026-11-13   → dates around a given day
//
// All names, phone numbers (555-01xx) and emails (@example.com) are made up.

const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');

const TODAY = process.argv[2] ? new Date(`${process.argv[2]}T12:00:00Z`) : new Date();
const OUT = path.join(__dirname, '..', 'samples', 'sample-orders.xlsx');

// Repeatable "random" numbers so the file is the same every run for a given day.
let seed = 20261113;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const chance = (p) => rand() < p;

const day = (offset) => { const d = new Date(TODAY); d.setUTCDate(d.getUTCDate() + offset); d.setUTCHours(0, 0, 0, 0); return d; };
const excelTime = (h, m) => new Date(Date.UTC(1899, 11, 30, h, m));   // how Excel stores a time of day

// Customers — the same person's phone is written differently on different orders, on purpose.
const CUSTOMERS = [
  ['Tom Becker', ['(555) 010-0101', '555-010-0101', '555.010.0101'], 'tom.becker@example.com'],
  ['Linda Ortiz', ['555-010-0102'], ''],
  ['Gary Hollis', ['555.010.0103', '5550100103'], 'ghollis@example.com'],
  ['Priya Nair', ['555-010-0104'], 'priya.nair@example.com'],
  ['Frank DeLuca', ['555-010-0105', '(555) 010-0105'], ''],
  ['Maureen Kelly', ['555-010-0106'], 'mo.kelly@example.com'],
  ['Sam Whitfield', ['555-010-0107'], ''],
  ['Rosa Alvarez', ['555-010-0108'], 'rosa.alvarez@example.com'],
  ['Dave Kowalski', ['555-010-0109', '555 010 0109'], 'dkowalski@example.com'],
  ['Angela Brooks', ['555-010-0110'], 'angela.b@example.com'],
  ['Mike Thompson', ['555-010-0111'], ''],
  ['Jenny Liu', ['555-010-0112'], 'jenny.liu@example.com'],
  ['Carlos Mendes', ['555-010-0113'], 'carlos.m@example.com'],
  ['Barb Schneider', ['555-010-0114', '(555)010-0114'], ''],
  ['Kevin O\'Brien', ['555-010-0115'], 'kobrien@example.com'],
  ['Hannah Weiss', ['555-010-0116'], 'hannah.weiss@example.com'],
  ['Ray Jackson', ['555-010-0117'], ''],
  ['Diane Russo', ['555-010-0118'], 'diane.russo@example.com'],
  ['Pete Novak', ['555-010-0119'], ''],
  ['Sarah Mitchell', ['555-010-0120'], 'smitchell@example.com'],
  ['Joe Bianchi', ['555-010-0121'], 'joe.bianchi@example.com'],
  ['Emily Carter', ['555-010-0122'], 'emily.carter@example.com'],
  ['Walt Hendricks', ['555-010-0123'], ''],
  ['Nina Patel', ['555-010-0124'], 'nina.patel@example.com'],
  ['The Riverside Grill', ['555-010-0125'], 'orders@riverside-grill.example.com'],
];

// [item, unit, price, [min, max] quantity, cut options]
const ITEMS = [
  ['Ribeye Steak', 'lb', 24.99, [2, 6], ['1" thick', '1.25" thick', '1.5" thick', 'bone-in', '']],
  ['New York Strip', 'lb', 21.99, [2, 5], ['1" thick', '1.25" thick', '']],
  ['Filet Mignon', 'lb', 34.99, [1, 3], ['2" thick', 'center cut', '']],
  ['Ground Beef (80/20)', 'lb', 6.99, [2, 10], ['1 lb packs', '2 lb packs', '']],
  ['Beef Brisket', 'lb', 8.99, [5, 15], ['whole packer', 'flat only', 'trimmed', '']],
  ['Chuck Roast', 'lb', 8.99, [3, 5], ['tied', '']],
  ['Short Ribs', 'lb', 10.99, [2, 5], ['English cut', 'flanken cut', '']],
  ['Pork Chops (bone-in)', 'lb', 6.99, [2, 5], ['1" thick', 'thin', '']],
  ['Pork Shoulder', 'lb', 4.99, [6, 10], ['bone-in', 'boneless, tied', '']],
  ['Baby Back Ribs', 'lb', 7.99, [3, 6], ['membrane removed', '']],
  ['Thick-Cut Bacon', 'lb', 9.99, [1, 3], ['']],
  ['Italian Sausage', 'lb', 7.49, [1, 4], ['hot', 'mild', '']],
  ['Whole Chicken', 'each', 14.99, [1, 3], ['spatchcock', 'cut in 8', '']],
  ['Chicken Breast (boneless)', 'lb', 6.99, [2, 6], ['butterflied', '']],
  ['Chicken Thighs', 'lb', 4.49, [2, 5], ['boneless', '']],
  ['Lamb Chops', 'lb', 22.99, [1, 3], ['frenched', '']],
  ['Leg of Lamb', 'lb', 13.99, [5, 8], ['butterflied', 'bone-in', '']],
  ['Beef Jerky', 'each', 8.99, [1, 4], ['']],
];
const HOLIDAY = {
  thanksgiving: [['Whole Turkey', 'lb', 3.49, [14, 24], ['fresh, not frozen', 'spatchcock', 'brined', '']],
    ['Smoked Ham', 'lb', 5.99, [6, 10], ['spiral cut', '']]],
  christmas: [['Prime Rib Roast', 'lb', 22.99, [5, 12], ['frenched & tied', 'bone-in, tied', 'boneless', '']],
    ['Beef Tenderloin (whole)', 'lb', 29.99, [4, 7], ['trimmed & tied', '']]],
};
const NOTES = ['Call when ready', 'Paid in advance', 'Picking up for her mother', 'Wants extra bones for stock',
  'Regular — same as last time', 'Bring to back door', 'Please vacuum seal everything'];
const TIMES = [[9, 0], [10, 0], [10, 30], [11, 0], [12, 0], [13, 30], [14, 0], [15, 0], [15, 30], [16, 0], [17, 0]];

// Holidays near the given day (US Thanksgiving = 4th Thursday of November).
const year = TODAY.getUTCFullYear();
const nov1 = new Date(Date.UTC(year, 10, 1));
const thanksgiving = new Date(Date.UTC(year, 10, 1 + ((4 - nov1.getUTCDay() + 7) % 7) + 21));
const christmasEve = new Date(Date.UTC(year, 11, 23));
const daysFromToday = (d) => Math.round((d - day(0)) / 864e5);

function makeOrder(pickupOffset, { holiday } = {}) {
  const [name, phones, email] = pick(CUSTOMERS);
  const itemCount = between(1, 4);
  const pool = holiday ? [...HOLIDAY[holiday], ...ITEMS] : ITEMS;
  const chosen = new Set(holiday ? [HOLIDAY[holiday][0][0]] : []);
  while (chosen.size < itemCount) chosen.add(pick(pool)[0]);
  const items = [...chosen].map((n) => {
    const [item, unit, price, [lo, hi], cuts] = pool.find((p) => p[0] === n);
    const qty = unit === 'lb' ? between(lo * 2, hi * 2) / 2 : between(lo, hi);
    return { item, unit, price, qty, cut: pick(cuts) };
  });
  return {
    name: chance(0.08) ? name.toLowerCase() : name,      // sloppy typing happens
    phone: pick(phones),
    email: chance(0.85) ? email : '',
    orderOffset: pickupOffset - between(1, 10),
    pickupOffset,
    time: chance(0.75) ? pick(TIMES) : null,
    note: chance(0.2) ? pick(NOTES) : (holiday === 'thanksgiving' ? 'Thanksgiving' : holiday === 'christmas' ? 'Christmas' : ''),
    items,
  };
}

const orders = [];
for (let i = 0; i < 70; i++) orders.push({ ...makeOrder(-between(1, 100)), past: true });       // past orders
for (let i = 0; i < 10; i++) orders.push(makeOrder(between(0, 7)));                              // this week
const tg = daysFromToday(thanksgiving) - 1;
if (tg >= 0) for (let i = 0; i < 9; i++) orders.push(makeOrder(tg - between(0, 1), { holiday: 'thanksgiving' }));
const xm = daysFromToday(christmasEve);
if (xm >= 0 && xm < 60) for (let i = 0; i < 6; i++) orders.push(makeOrder(xm - between(0, 1), { holiday: 'christmas' }));
for (let i = 0; i < 3; i++) orders.push({ ...makeOrder(-between(1, 20)), past: true, cancelled: true });
for (const o of orders) if (o.orderOffset > 0) o.orderOffset = 0;                                // can't order in the future
orders.sort((a, b) => a.orderOffset - b.orderOffset);

function statusFor(o) {
  if (o.cancelled) return 'Cancelled';
  if (o.past) return pick(['Picked up', 'Picked up', 'Done', 'Picked up']);
  if (o.pickupOffset === 0) return pick(['Ready', 'Cutting', 'Ready']);
  if (o.pickupOffset === 1) return pick(['Cutting', 'New', '']);
  return pick(['New', '', 'Ordered']);
}

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sample data generator';
  const ws = wb.addWorksheet('Order Log');
  ws.addRow([`Butcher Shop — Order Log ${year}   (FAKE TEST DATA)`]).font = { bold: true, size: 14 };
  ws.addRow([]);
  const header = ['Order #', 'Order Date', 'Customer', 'Phone', 'Email', 'Item', 'Qty', 'Unit', 'Price', 'Total',
    'Cut Instructions', 'Pickup Date', 'Pickup Time', 'Status', 'Notes'];
  const h = ws.addRow(header);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7A1F1F' } }; });
  ws.views = [{ state: 'frozen', ySplit: 3 }];

  let number = 1001;
  let rows = 0;
  for (const o of orders) {
    const fullRows = chance(0.3);   // most orders only have the customer on the first line
    o.items.forEach((it, idx) => {
      const first = idx === 0;
      const show = first || fullRows;
      const qty = !first && chance(0.1) && it.unit === 'lb' ? `${it.qty} lbs` : it.qty;   // the odd typed-in "2.5 lbs"
      const r = ws.addRow([
        show ? number : '',
        show ? day(o.orderOffset) : '',
        show ? o.name : '',
        show ? o.phone : '',
        show ? o.email : '',
        it.item,
        qty,
        it.unit === 'lb' ? 'lb' : 'ea',
        it.price,
        null,
        it.cut,
        show ? day(o.pickupOffset) : '',
        show && o.time ? excelTime(...o.time) : '',
        first ? statusFor(o) : '',
        first ? o.note : '',
      ]);
      const total = Math.round(it.qty * it.price * 100) / 100;
      r.getCell(10).value = typeof qty === 'number' ? { formula: `G${r.number}*I${r.number}`, result: total } : total;
      rows++;
    });
    number++;
  }

  const widths = [9, 12, 20, 16, 30, 26, 8, 6, 9, 10, 22, 12, 11, 11, 30];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(2).numFmt = 'm/d/yyyy';
  ws.getColumn(12).numFmt = 'm/d/yyyy';
  ws.getColumn(13).numFmt = 'h:mm AM/PM';
  ws.getColumn(9).numFmt = '$#,##0.00';
  ws.getColumn(10).numFmt = '$#,##0.00';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await wb.xlsx.writeFile(OUT);
  console.log(`Wrote ${OUT}: ${orders.length} orders, ${rows} item rows, ${CUSTOMERS.length} customers (all fake).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
