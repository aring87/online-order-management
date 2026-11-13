# Butcher Shop — Orders Program

A database for every customer order and item, replacing a hand-kept Excel sheet.
**Click a customer's name to see all of their orders**: every item, weight, price, cut instructions, dates and totals.

Every order has an **order number** (#47). It's shown big on screen, on the printed ticket and on the customer's confirmation, so staff can say "do number 47" instead of reading the whole order out.

- **Prep board** (home screen): every open order as a numbered ticket in **New → Preparing → Ready** columns, soonest pickup first. Overdue and due-today orders are highlighted.
  - Helpers tick each item as it's cut and packed. Ticking the first item moves the order to Preparing.
  - **🖨 Print** gives a ticket with a big number and a checklist to go with the meat or onto the bag.
  - **⛶ Full screen** suits a screen or tablet in the back.
- **Online orders:** website orders appear **instantly**, with no refresh needed. You get a pop-up, an unread count on the tab and in the browser tab title, and (after clicking **🔔 Turn on order alerts**) a chime and a desktop notification. Click **Got it** once an order has been seen. Online orders also go straight onto the prep board.
- **Customers:** the customer list is on the left. Click a name to see their full order history. The search box finds customers by name, phone, email **or item** (type "brisket" to see everyone who has ordered brisket).
- **Orders:** every order, organized the way he chooses with the **Organize by** switch. The program remembers his choice.
  - **👤 Customer:** each customer with all of their orders and items underneath.
  - **🥩 Item:** each cut with the **total needed**, then each order wanting it. For example, "Beef Brisket — 25 lb: #1 Tom 12 lb (trimmed), #3 Gary 5 lb (flat only)…". Items can be ticked off as packed. Search an item ("brisket") to see just that one.
  - **📅 Pickup day:** Overdue, Today, Tomorrow, then each following day, sorted by pickup time.
  - **# Order:** a plain list by order number.
  - **Filters:** open orders or all orders (or one status), a pickup date (overdue, today, tomorrow, next 7 days), and where the order came from (online, in-store, imported).
  - **🖨 Print this list** prints exactly what's on screen. Organized by Item, it makes a cut list for the back.
- **New order:** enter phone or walk-in orders, with a pickup date and ready-by time. Start typing a name to pick an existing customer.
- **Import from Excel:** load the existing spreadsheet (.xlsx or .csv). See below.
- **Export to Excel:** download everything as a spreadsheet, one row per item.
- **Stripe:** paid Stripe Checkout and Payment Link orders come in by themselves as online orders, marked **💳 Paid**. See "Connecting Stripe" below.
- **Online order page** (`/`): customers pick cuts, add cutting instructions, and choose a pickup date and time. They're shown their order number when they're done.

## Starting the program

1. Install **Node.js** (the "LTS" version) from https://nodejs.org. You only need to do this once.
2. Double-click **`start-windows.bat`** (Windows) or **`start-mac.command`** (Mac).
   The first start takes a minute to set up. After that, the program opens in your web browser.
3. The program opens straight to the orders. There's no login screen while no password is set, and only this computer can open the program.

Keep the black window open while you use the program. Closing it stops the program, but your data stays saved.
To open the program again, double-click the start file, or go to http://localhost:3000/admin.

> On a Mac, the first time you open `start-mac.command`, right-click it and choose **Open**.

## Importing the Excel spreadsheet

1. Click **Import from Excel** and choose the file. Old `.xls` files must be re-saved as `.xlsx` first (File → Save As → Excel Workbook).
2. The program guesses which column is which from the headings (customer name, phone, item, weight, price…). Check the guesses, and fix any that are wrong with the drop-downs. The preview shows exactly what will be imported.
3. Choose whether the imported orders are past orders (**Picked up / Delivered**) or still open (**New**), then click **Import**.

How the spreadsheet is read:
- **Grouping into orders:** rows with the same order number become one order. With no order number, rows for the same customer on the same date become one order.
- **Follow-on rows:** a row that has an item but no customer (common when one order spans several lines) is added to the customer above it.
- **Returning customers:** customers are recognised by email, then phone number (in any format, e.g. `(555) 201-4410` = `555.201.4410`), then name. Each customer appears once, with all of their orders.
- **Re-importing:** importing the same file again won't create duplicates. If the sheet has new rows, only the new orders are added.
- **Skipped rows:** rows with no customer or no item are listed after the import so you can check them.

## Connecting Stripe

Once connected, every **paid** Stripe order (Checkout or Payment Links) appears on the **Online orders** tab with the customer's name, email, phone, items and quantities. It's marked **💳 Paid** on screen and on the printed ticket. Orders are never added twice, and unpaid or abandoned checkouts are ignored.

**Step 1: Give the program a read-only Stripe key.** This works on the shop computer as-is, and new paid orders appear within a minute.
1. In Stripe, go to **Developers → API keys → Create restricted key**.
2. Name it "Orders program". Set **Checkout Sessions** and **Products** to **Read**, and leave everything else as None. Create the key.
3. Open the `.env` file and add the key on its own line: `STRIPE_SECRET_KEY=rk_live_...`. Never send this key by email or chat.
4. Restart the program. The Online orders tab will say **Stripe connected**.

The first time, it brings in paid orders from the last 2 days. To bring in more, set `STRIPE_FIRST_SYNC_DAYS=30` before the first start.

**Step 2 (optional, only when the program is hosted online): instant orders.**
1. In Stripe, go to **Developers → Webhooks → Add endpoint**.
2. Use the URL `https://YOUR-SITE/api/stripe/webhook` and choose the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. Copy the **signing secret** into `.env` as `STRIPE_WEBHOOK_SECRET=whsec_...` and restart the program.

**Getting pickup date, time and cut instructions from Stripe.** In each Payment Link (or Checkout settings), add up to 3 **custom fields**, for example "Pickup date", "Pickup time" and "Cutting instructions".
- **Pickup date and time:** the program reads these into the order, so the prep board can sort by them.
- **Anything else:** added to the order notes, including dates it can't read, like "Saturday morning".

**Units.** Products whose name includes "per lb" (or that have the metadata `unit = lb` in Stripe) are shown in pounds. Everything else is shown as a count.

Totals shown are the item totals from Stripe; tax and shipping are not included.

## Test data

**`samples/sample-orders.xlsx`** is a **fake** order log for trying the program out. It has 98 orders from 25 made-up customers: past orders, this week's orders, and Thanksgiving and Christmas orders. Import it with **Import from Excel**.

It is laid out like a hand-kept sheet, to give the importer a realistic test:
- A title row above the headings.
- Orders spread over several rows, often with the customer only on the first line.
- The same customer's phone number written different ways.
- The odd lowercase name, and a typed-in "2.5 lbs".
- A Status column, and Excel dates and times.

To make a fresh copy with dates around today, run `npm run sample-data`.

To start over with an empty program, close the program and delete the `data` folder. **Don't do this once real orders are in it.**

## Backing up

All data is stored in one file: **`data/orders.db`**. Copy this file somewhere safe (a USB stick or cloud folder) regularly.
**Export to Excel** also gives you a readable copy of everything.

## Settings (`.env` file)

| Setting          | Default            | Purpose                                     |
|------------------|--------------------|---------------------------------------------|
| `ADMIN_PASSWORD` | blank (no login)   | Set one to require a login. Needed to use the program from other devices or to host it online |
| `PORT`           | `3000`             | Port the program runs on                    |
| `DB_FILE`        | `data/orders.db`   | Where the database file is kept             |
| `SESSION_SECRET` | auto-generated     | Only needed when hosting online             |
| `TRUST_PROXY`    | unset              | Set to `true` when hosted behind a proxy    |
| `STRIPE_SECRET_KEY` | unset           | Restricted Stripe key: brings in paid orders |
| `STRIPE_WEBHOOK_SECRET` | unset       | Optional: instant Stripe orders when hosted |

## Product list

The product list and prices offered on the online order form and suggested in **New order** are in `SEED_PRODUCTS` in `src/db.js`. Edit them before the first start. Imported and hand-entered items don't have to be on the list.

## For developers

```bash
npm install
npm test        # automated tests
npm start       # runs at http://localhost:3000/admin
```

Requires Node.js 22.13 or newer. It uses Node's built-in SQLite, so there's no database server to install.
Database tables: `customers`, `orders` (with `source`: online / manual / import), `order_items` and `products`.

The online order form (`/`) and the admin can also be installed on phones as apps (Progressive Web Apps) if the program is hosted online with HTTPS.
