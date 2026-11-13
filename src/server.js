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
const app = createApp(db, { adminPassword: ADMIN_PASSWORD });

app.listen(PORT, () => {
  console.log(`Order form:  http://localhost:${PORT}/`);
  console.log(`Admin:       http://localhost:${PORT}/admin  (any username, password = ADMIN_PASSWORD)`);
  console.log(`Database:    ${DB_FILE}`);
});
