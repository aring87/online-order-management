# Butcher Shop — Orders Program

A database for every customer order and item, replacing a hand-kept Excel sheet.
**Click a customer's name to see all of their orders**: every item, weight, price, cut instructions, dates and totals.

- **Customers:** the customer list is on the left. Click a name to see their full order history on the right. The search box finds customers by name, phone, email **or item** (type "brisket" to see everyone who has ordered brisket).
- **All orders:** every order, newest first, with the items listed. Search by customer, item or order number, and filter by status.
- **New order:** enter phone or walk-in orders. Start typing a name to pick an existing customer. Prices fill in from the product list, and you can also type any item.
- **Import from Excel:** load the existing spreadsheet (.xlsx or .csv). See below.
- **Export to Excel:** download everything as a spreadsheet, one row per item.
- **Status:** mark each order New, Preparing, Ready, Picked up / Delivered or Cancelled. Orders can also be deleted.
- **Online ordering (optional):** customers can place orders themselves at `/`, and those orders show up here too.

## Starting the program

1. Install **Node.js** (the "LTS" version) from https://nodejs.org. You only need to do this once.
2. Double-click **`start-windows.bat`** (Windows) or **`start-mac.command`** (Mac).
   The first start takes a minute to set up. After that, the program opens in your web browser.
3. Log in with the password from the **`.env`** file. It starts as `changeme`; open `.env` in Notepad to change it.

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

## Backing up

All data is stored in one file: **`data/orders.db`**. Copy this file somewhere safe (a USB stick or cloud folder) regularly.
**Export to Excel** also gives you a readable copy of everything.

## Settings (`.env` file)

| Setting          | Default            | Purpose                                     |
|------------------|--------------------|---------------------------------------------|
| `ADMIN_PASSWORD` | `changeme`         | Password for logging in                     |
| `PORT`           | `3000`             | Port the program runs on                    |
| `DB_FILE`        | `data/orders.db`   | Where the database file is kept             |
| `SESSION_SECRET` | auto-generated     | Only needed when hosting online             |
| `TRUST_PROXY`    | unset              | Set to `true` when hosted behind a proxy    |

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
