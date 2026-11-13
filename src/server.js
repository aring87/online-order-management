'use strict';

const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'orders.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD is not set — using the default "changeme". Set it before going live.');
}

const db = openDb(DB_FILE);
// Set SESSION_SECRET to keep staff logged in across server restarts.
const app = createApp(db, { adminPassword: ADMIN_PASSWORD, sessionSecret: process.env.SESSION_SECRET || undefined });
// Behind a hosting proxy (Render, Railway, Fly, nginx…) this makes HTTPS detection and IPs correct.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

app.listen(PORT, () => {
  console.log(`Order form:  http://localhost:${PORT}/`);
  console.log(`Admin:       http://localhost:${PORT}/admin  (password = ADMIN_PASSWORD)`);
  console.log(`Database:    ${DB_FILE}`);
});
