'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'orders.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD is not set — using the default "changeme". Set it in the .env file.');
}

// Keep staff logged in across restarts: use SESSION_SECRET, or a random one saved next to the database.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(path.dirname(DB_FILE), '.session-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* create it */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, secret, { mode: 0o600 }); } catch { /* in-memory only */ }
  return secret;
}

const db = openDb(DB_FILE);
const app = createApp(db, {
  adminPassword: ADMIN_PASSWORD,
  sessionSecret: sessionSecret(),
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    ...(process.env.STRIPE_API_BASE ? { apiBase: process.env.STRIPE_API_BASE } : {}),  // for testing only
  },
});
app.locals.stripe.start();
// Behind a hosting proxy (Render, Railway, Fly, nginx…) this makes HTTPS detection and IPs correct.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
}

const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log(`  Orders program:  ${url}/admin`);
  console.log(`  Online order form: ${url}/`);
  console.log(`  Database:        ${DB_FILE}`);
  const st = app.locals.stripe.status;
  console.log(`  Stripe:          ${st.enabled ? `connected — checking for paid orders every minute${st.webhook ? ' (+ instant webhook)' : ''}` : 'not connected (add STRIPE_SECRET_KEY to .env)'}`);
  console.log('');
  console.log('  Keep this window open while using the program. Close it to stop.');
  if (process.env.OPEN_BROWSER === '1') openBrowser(`${url}/admin`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — the program is probably already running.`);
    console.error(`  Open http://localhost:${PORT}/admin in your browser.\n`);
    if (process.env.OPEN_BROWSER === '1') openBrowser(`http://localhost:${PORT}/admin`);
    process.exitCode = 1;
  } else throw err;
});
