# Despatch Scale Labels

Standalone app for the despatch team to replace the paper "Packing Labels
Request Form": stream live weight from the scale indicator, key in the
carton lines, and save the request to SQL Server. Reports are searchable
and exportable to PDF/Excel. Runs completely independently of the
weighbridge system (own folder, own dependencies, own database).

## Setup

1. `npm install`
   > `serialport`@9 needs a native binding compiled for your Node/OS/arch.
   > If `npm install` fails on `@serialport/bindings` with a `node-gyp` /
   > "Could not find any Visual Studio installation" error, either install
   > the [Visual Studio Build Tools](https://github.com/nodejs/node-gyp#on-windows)
   > ("Desktop development with C++") and re-run `npm install`, or copy
   > the already-built `serialport` + `@serialport/*` folders from another
   > project on this machine running the same Node version (e.g.
   > `weighbridge-nodejs/node_modules`) into this project's
   > `node_modules` — that's how this app's own `node_modules` was set up.
2. Copy `.env.example` to `.env` (already done for local dev) and point it
   at your SQL Server instance:
   ```
   DB_HOST=127.0.0.1
   DB_PORT=1433
   DB_USER=sa
   DB_PASSWORD=YourStrong!Passw0rd
   DB_NAME=despatch_labels
   ```
   The database itself must already exist (create it once with
   `CREATE DATABASE despatch_labels;` in SQL Server Management Studio /
   `sqlcmd`) — the app creates its own tables inside it on first boot.
3. `npm start` — serves the app on `http://localhost:3100` (change with
   `PORT` in `.env`).

If the database isn't reachable, the app still starts (so you can fix the
`.env` without restarting your terminal), but every `/api/requests*` and
`/api/settings*` endpoint returns `503` until it is.

## Scale connection

Uses the same serial-port auto-detection approach as the weighbridge
system (`lib/scale.js`): it tries a list of baud/parity profiles against
the selected COM port until one produces a valid weight frame, then
streams live readings to the browser over Server-Sent Events
(`GET /api/scale/stream/:com`).

- `GET /api/get-comport-list` — lists available COM ports (`SerialPort.list()`).
- If the indicator's baud rate is known ahead of time, set
  `SCALE_BAUD_RATE` in `.env` to skip the auto-detect fallback list, or
  `SCALE_FORCE_BAUD=true` to use only that rate.
- The UI's "Manual weight entry" checkbox lets you key in a gross weight
  by hand when no scale is connected.

## Data model

- `despatch_requests` — header: Labels Requested By / Applied By / Printed
  By, Customer Name, Customer Reference No., Airway Bill No., Request
  Date, status (`OPEN` while lines are being added, `COMPLETED` once
  finalized).
- `despatch_lines` — one row per carton: Carton No., Product Description,
  Gross Weight (captured from the scale or entered manually), Crate
  Count, Crate Weight (kg, snapshotted from the setting in effect at
  capture time), Net Weight (`gross - crateCount * crateWeight`,
  computed server-side), Production Date, Expiry Date.
- `app_settings` — key/value settings; `crate_settings` holds the
  standard crate weight (default 1.8kg), editable via
  `GET`/`PUT /api/settings/crate-weight`.

## Reports

The Reports tab filters by date range, customer, requested-by, and
airway bill no. Each request row can be downloaded as PDF or Excel
(`/api/requests/:id/pdf`, `/api/requests/:id/excel`), and the whole
filtered list can be exported as a summary workbook via
"Export filtered (Excel)" (`/api/requests/export/excel`).
