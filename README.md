# Butcher Shop — Online Orders

A small web app for taking online butcher orders, saving them in a database, and viewing every order grouped by customer.

- **Order form** (`/`): customers pick cuts by weight (lb) or count, add cutting instructions per item, choose pickup or delivery and a date, and submit.
- **Admin** (`/admin`, password protected):
  - **Customers**: every customer, with order count, open orders, total spent and last order date. You can search by name, email or phone.
  - **Customer detail**: contact info and the full order history. Each order shows its items, quantities, prices, cut instructions, notes, pickup/delivery details and total.
  - **All orders**: every order, newest first, filterable by status.
  - Change an order's status (New → Preparing → Ready → Picked up / Delivered, or Cancelled).

Returning customers are matched by email, so all of their orders appear together.

## Running it

Requires **Node.js 22.13+**. It uses Node's built-in SQLite, so there's no database server to install.

```bash
npm install
ADMIN_PASSWORD=your-secret npm start
```

- Order form: http://localhost:3000/
- Admin: http://localhost:3000/admin. Use any username, and the password is `ADMIN_PASSWORD`.

| Env var          | Default            | Purpose                       |
|------------------|--------------------|-------------------------------|
| `ADMIN_PASSWORD` | `changeme`         | Password for the admin pages  |
| `PORT`           | `3000`             | HTTP port                     |
| `DB_FILE`        | `data/orders.db`   | SQLite database file location |

## Products

The database is seeded on first start with a starter catalog (beef, pork, poultry, lamb). To change products or prices, edit `SEED_PRODUCTS` in `src/db.js` before first run, or edit the `products` table directly (prices are in cents; set `active = 0` to hide an item).

Per-pound prices are shown to customers as estimates. The final price depends on the actual cut weight.

## Database tables

- `customers`: name, email (unique), phone
- `products`: name, category, unit (`lb`/`each`), price
- `orders`: customer, status, pickup/delivery, date, address, notes, total
- `order_items`: product, quantity, price at time of order, cut instructions

## Tests

```bash
npm test
```
