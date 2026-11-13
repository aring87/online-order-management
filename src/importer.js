'use strict';

const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { transaction, nameKey, phoneKey } = require('./db');
const { findOrCreateCustomer, insertOrder } = require('./orders');

// Fields a spreadsheet column can be mapped to, with header names we recognise automatically.
const FIELDS = {
  order_ref:        { label: 'Order number',       guess: /^(order|invoice|receipt|ticket)?\s*(#|no\.?|num(ber)?|id|ref)$|^order$/i },
  order_date:       { label: 'Order date',         guess: /^(order\s*)?date$|^(date\s*)?(ordered|placed)|^order\s*date|^created/i },
  pickup_date:      { label: 'Pickup / due date',  guess: /pick\s*-?up|due|deliver(y)?\s*date|collect/i },
  pickup_time:      { label: 'Pickup time',        guess: /time/i },
  status:           { label: 'Status',             guess: /^(order\s*)?status$|^state$|^stage$|^done\??$/i },
  customer_name:    { label: 'Customer name',      guess: /^(customer|client|full)?\s*name$|^customer$|^client$|name/i },
  first_name:       { label: 'First name',         guess: /^first(\s*name)?$/i },
  last_name:        { label: 'Last name',          guess: /^(last|sur)(\s*name)?$/i },
  email:            { label: 'Email',              guess: /e-?mail/i },
  phone:            { label: 'Phone',              guess: /phone|mobile|cell|tel/i },
  product:          { label: 'Item / product',     guess: /^(item|product|cut|meat|description|desc)s?(\s*name)?$/i },
  quantity:         { label: 'Quantity / weight',  guess: /qty|quantity|weight|lbs?|pounds|amount$/i },
  unit:             { label: 'Unit (lb / each)',   guess: /^units?$|^uom$/i },
  unit_price:       { label: 'Price per unit',     guess: /^(unit\s*)?price|price\s*(per|\/)|rate|\$\s*\/\s*lb/i },
  line_total:       { label: 'Line total',         guess: /total|subtotal|amount\s*due|line/i },
  cut_instructions: { label: 'Cut instructions',   guess: /cut|instruction|prep|thick|special/i },
  notes:            { label: 'Order notes',        guess: /note|comment|remark/i },
  address:          { label: 'Delivery address',   guess: /address|street/i },
};

class ImportError extends Error {}

// ---------- Reading files ----------

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);                       // formula
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return cellText(v.text);                            // hyperlink
    if ('error' in v) return '';
    return String(v);
  }
  return v;
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';'
    : text.split('\n')[0].includes('\t') && !text.split('\n')[0].includes(',') ? '\t' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Read an .xlsx or .csv file into { sheets, sheet, headers, rows }. Rows are arrays of strings/numbers/dates. */
async function readSpreadsheet(buffer, filename, sheetName) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  let grid, sheets = [], sheet = null;

  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    grid = parseCsv(buffer.toString('utf8'));
  } else if (ext === 'xlsx' || ext === 'xlsm') {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); } catch { throw new ImportError('Could not read that Excel file. Try saving it again as .xlsx.'); }
    const ws = wb.worksheets.filter((w) => w.state !== 'hidden');
    sheets = ws.map((w) => w.name);
    const chosen = ws.find((w) => w.name === sheetName) || ws.find((w) => w.actualRowCount > 1) || ws[0];
    if (!chosen) throw new ImportError('That workbook has no sheets.');
    sheet = chosen.name;
    grid = [];
    chosen.eachRow({ includeEmpty: false }, (r) => {
      const vals = [];
      r.eachCell({ includeEmpty: true }, (cell, col) => { vals[col - 1] = cellText(cell.value); });
      grid.push(Array.from(vals, (v) => (v === undefined ? '' : v)));
    });
  } else if (ext === 'xls') {
    throw new ImportError('Old .xls files aren\'t supported. In Excel choose File → Save As → "Excel Workbook (.xlsx)" and upload that.');
  } else {
    throw new ImportError('Please upload an Excel (.xlsx) or CSV file.');
  }

  const isBlank = (r) => r.every((v) => String(v ?? '').trim() === '');
  grid = grid.filter((r) => !isBlank(r));
  if (grid.length < 2) throw new ImportError('The sheet needs a header row and at least one row of orders.');

  // Header = first row with at least 2 text cells (skips title rows like "Holiday Orders 2026").
  let h = grid.findIndex((r) => r.filter((v) => typeof v === 'string' && v.trim()).length >= 2);
  if (h < 0) h = 0;
  const width = Math.max(...grid.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => String(grid[h][i] ?? '').trim() || `Column ${i + 1}`);
  const rows = grid.slice(h + 1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return { sheets, sheet, headers, rows, mapping: guessMapping(headers) };
}

function guessMapping(headers) {
  const mapping = {};
  const used = new Set();
  // Most specific fields first so e.g. "Order Date" isn't taken as "Order number".
  const order = ['email', 'phone', 'first_name', 'last_name', 'status', 'order_date', 'pickup_time', 'pickup_date', 'order_ref', 'unit_price',
    'line_total', 'quantity', 'unit', 'cut_instructions', 'product', 'customer_name', 'notes', 'address'];
  for (const field of order) {
    const i = headers.findIndex((hd, idx) => !used.has(idx) && FIELDS[field].guess.test(hd.trim()));
    if (i >= 0) { mapping[field] = i; used.add(i); }
  }
  if (mapping.customer_name == null && mapping.first_name == null) delete mapping.last_name;
  return mapping;
}

// ---------- Value parsing ----------

function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {                     // Excel serial date
    return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);                    // US style m/d/yyyy
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    let [mo, d] = [Number(m[1]), Number(m[2])];
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];                                // clearly d/m/yyyy
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function toCents(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  const s = String(v ?? '').replace(/[,$£€\s]/g, '');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Math.round(Number(m[0]) * 100) : null;
}

function toQuantity(v) {
  if (typeof v === 'number') return { qty: v, unit: null };
  const s = String(v ?? '').trim().toLowerCase();
  const m = s.match(/(\d+(\.\d+)?|\.\d+)/);
  if (!m) return { qty: null, unit: null };
  const unit = /lb|pound|#/.test(s) ? 'lb' : /ea|each|pc|piece|x\b|ct/.test(s) ? 'each' : null;
  return { qty: Number(m[1]), unit };
}

// "3:30 PM", "15:30", an Excel time cell (a Date on 30 Dec 1899, or a fraction of a day) → "HH:MM"
function parseTime(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]?.startsWith('p') && h < 12) h += 12;
  if (m[3]?.startsWith('a') && h === 12) h = 0;
  if (!m[2] && !m[3]) return null;                      // a bare "3" is too ambiguous
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}
function toTime(v) {
  const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (v instanceof Date && !isNaN(v)) return hhmm(v.getUTCHours(), v.getUTCMinutes());
  if (typeof v === 'number' && v >= 0 && v < 1) { const mins = Math.round(v * 1440); return hhmm(Math.floor(mins / 60) % 24, mins % 60); }
  const iso = String(v ?? '').match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);   // a time cell after the trip through the browser
  if (iso) return `${iso[1]}:${iso[2]}`;
  return parseTime(v);
}

// "Picked up", "Done", "Ready", "Cutting"… → our statuses
function toStatus(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/cancel|void|refund/.test(s)) return 'cancelled';
  if (/pick|done|complete|deliver|collect|closed|filled|paid|^yes$|^y$|^x$|✓|✔/.test(s)) return 'picked_up';
  if (/ready/.test(s)) return 'ready';
  if (/prep|progress|cutting|working|started/.test(s)) return 'preparing';
  if (/new|open|pending|order|^no$|^n$|wait/.test(s)) return 'new';
  return null;
}

function toUnit(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/lb|pound|#/.test(s)) return 'lb';
  return 'each';
}

// ---------- Import ----------

/**
 * Import rows into the database.
 * Rows sharing an order number become one order; without an order number, rows for the same
 * customer on the same date are grouped. Orders already imported are skipped.
 */
function importRows(db, { headers, rows, mapping, status = 'picked_up' }) {
  if (!Array.isArray(rows) || !Array.isArray(headers)) throw new ImportError('Nothing to import.');
  const col = (row, field) => (mapping[field] == null || mapping[field] === '' ? '' : row[Number(mapping[field])] ?? '');
  const text = (row, field) => {
    const v = col(row, field);
    return (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).trim();
  };
  if (mapping.customer_name == null && mapping.first_name == null && mapping.email == null && mapping.phone == null) {
    throw new ImportError('Choose which column has the customer\'s name (or email / phone).');
  }
  if (mapping.product == null) throw new ImportError('Choose which column has the item / product.');

  // A heading like "Weight (lbs)" or "Price/lb" tells us items are sold by the pound.
  const headerSays = (field) => (mapping[field] == null ? '' : String(headers[Number(mapping[field])] ?? ''));
  const headerUnit = /lb|pound|weight/i.test(headerSays('quantity') + headerSays('unit_price')) ? 'lb' : null;

  const products = db.prepare('SELECT id, name, unit, price_cents FROM products').all();
  const productByName = new Map(products.map((p) => [p.name.toLowerCase(), p]));

  const skipped = [];
  const groups = new Map();
  let lastCustomer = null;

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // spreadsheet row number (after header), for messages
    let name = text(row, 'customer_name');
    const first = text(row, 'first_name');
    const last = text(row, 'last_name');
    if (!name && (first || last)) name = `${first} ${last}`.trim();
    const email = text(row, 'email').toLowerCase();
    const phone = text(row, 'phone');
    const productName = text(row, 'product');
    let ref = text(row, 'order_ref');

    let customer = name || email || phone ? { name, email, phone } : null;
    // A row with an item but no customer continues the order above it (common layout in hand-kept sheets).
    if (!customer && productName && lastCustomer) {
      customer = lastCustomer.customer;
      ref ||= lastCustomer.ref;
    }
    if (!customer) { skipped.push({ row: rowNum, reason: 'No customer name, email or phone' }); return; }
    if (!productName) { skipped.push({ row: rowNum, reason: 'No item' }); return; }

    const date = toDate(col(row, 'order_date')) || (customer === lastCustomer?.customer ? lastCustomer.date : null);
    const { qty: parsedQty, unit: qtyUnit } = toQuantity(col(row, 'quantity'));
    const catalog = productByName.get(productName.toLowerCase());
    const unit = toUnit(col(row, 'unit')) || qtyUnit || catalog?.unit || headerUnit || 'each';
    let quantity = parsedQty ?? (mapping.quantity == null ? 1 : null);
    if (!quantity || quantity <= 0) { skipped.push({ row: rowNum, reason: `No quantity for "${productName}"` }); return; }
    quantity = Math.round(quantity * 100) / 100;

    let unitPrice = toCents(col(row, 'unit_price'));
    let lineTotal = toCents(col(row, 'line_total'));
    if (unitPrice == null && lineTotal != null) unitPrice = Math.round(lineTotal / quantity);
    if (unitPrice == null && catalog) unitPrice = catalog.price_cents;
    if (unitPrice == null) unitPrice = 0;
    if (lineTotal == null) lineTotal = Math.round(unitPrice * quantity);

    const custKey = (customer.email && `e:${customer.email}`) || (phoneKey(customer.phone) && `p:${phoneKey(customer.phone)}`)
      || `n:${nameKey(customer.name)}`;
    const groupKey = ref ? `ref:${ref}` : `auto:${custKey}|${date || ''}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        ref, customer, date,
        pickupDate: toDate(col(row, 'pickup_date')),
        pickupTime: toTime(col(row, 'pickup_time')),
        status: toStatus(col(row, 'status')),
        notes: text(row, 'notes'),
        address: text(row, 'address'),
        items: [],
      });
    }
    const g = groups.get(groupKey);
    const extraNote = text(row, 'notes');
    if (extraNote && !g.notes.includes(extraNote)) g.notes = g.notes ? `${g.notes}; ${extraNote}` : extraNote;
    g.items.push({
      productId: catalog?.id ?? null,
      name: productName.slice(0, 200),
      unit,
      quantity,
      unitPriceCents: unitPrice,
      lineTotalCents: lineTotal,
      cut: text(row, 'cut_instructions').slice(0, 300),
    });
    lastCustomer = { customer, date, ref };
  });

  const result = { orders_created: 0, items_created: 0, customers_created: 0, duplicates: 0, skipped };
  const now = new Date();
  const today = new Date(now - now.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const exists = db.prepare('SELECT 1 FROM orders WHERE import_key = ?');

  transaction(db, () => {
    for (const g of groups.values()) {
      const fingerprint = g.ref ? `ref:${g.ref}` : `auto:${crypto.createHash('sha1').update(JSON.stringify([
        nameKey(g.customer.name), g.customer.email, phoneKey(g.customer.phone), g.date,
        g.items.map((i) => [i.name.toLowerCase(), i.quantity, i.lineTotalCents]),
      ])).digest('hex')}`;
      if (exists.get(fingerprint)) { result.duplicates++; continue; }

      const c = findOrCreateCustomer(db, g.customer);
      if (c.created) result.customers_created++;
      // Keep the spreadsheet's order number as ours when it's a plain number that isn't taken,
      // so "order 1047" means the same thing in both places. New orders then continue from there.
      const sheetNumber = /^\d{1,9}$/.test(g.ref) ? Number(g.ref) : null;
      const keepNumber = sheetNumber && !db.prepare('SELECT 1 FROM orders WHERE id = ?').get(sheetNumber);
      insertOrder(db, {
        id: keepNumber ? sheetNumber : null,
        customerId: c.id,
        // Status column wins; otherwise an order still to be picked up is New; otherwise the choice made on screen.
        status: g.status || (g.pickupDate && g.pickupDate >= today ? 'new' : status),
        pickupTime: g.pickupTime,
        fulfillment: g.address ? 'delivery' : 'pickup',
        pickupDate: g.pickupDate,
        deliveryAddress: g.address,
        notes: g.notes.slice(0, 1000),
        createdAt: g.date ? `${g.date} 12:00:00` : null,
        source: 'import',
        orderRef: g.ref || null,
        importKey: fingerprint,
        items: g.items,
      });
      result.orders_created++;
      result.items_created += g.items.length;
    }
  });
  return result;
}

module.exports = { readSpreadsheet, importRows, guessMapping, parseCsv, toDate, toTime, toStatus, parseTime, FIELDS, ImportError };
