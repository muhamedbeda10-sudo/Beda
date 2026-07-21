# QC System · Inspection Recorder

A web application for recording and tracking quality-control inspections in a
manufacturing environment. It covers the full inspection lifecycle — from
selecting a production order and starting a session, through recording samples,
dimensional measurements, visual defects and photos, to closing the session and
reviewing results in History, Analytics, Settings and Audit Logs.

Built to replace/complement a Power Apps prototype. Works on **desktop and
mobile** (responsive, touch-friendly, light + dark mode).

## Roles

- **QC Inspectors** — record samples, measurements, defects and images.
- **Production Supervisors** — track inspection coverage per order.
- **Quality Managers** — analyse trends, recurring defects and machine performance.

## Features

### Inspections (home)
- Open / all inspection sessions grouped by machine and order.
- **New Inspection** flow: pick a production order and link it to a session.
- **Paint Sample** machines (7, 11, 48) skip straight into the flow; other
  machines show a start-session confirmation popup (quantity + confirm).
- Continue an existing session, view/expand order details and recorded samples.
- Set / edit quantity, close a session, and get a **Hold defect warning** before
  closing.

### Inspection workflow (session)
- Add **Inspection Samples** (1-1, 2-1 …).
- Enter **Dimension Results** with target ± tolerance and automatic
  Pass / Warning / Fail evaluation.
- Record **Visual Defects** (bilingual EN/AR) with severity, quantity and
  disposition (Accepted / Hold / Rejected).
- **Capture or upload images** per sample and per defect.
- Review images in a **zoom / lightbox viewer** (pan, zoom, rotate, gallery).
- Close the session with a final quantity; results are linked to the order.

### Order Summary
- Review production orders, machine, item and inspection coverage.
- Filter and drill into an order's sessions; start an inspection directly.

### Analytics
- Time filters (last 7 / 14 / 30 / 90 days).
- KPIs: sessions, samples, measurements, defects, pass rate, open sessions.
- Charts: inspection trend, defect breakdown, machine performance, result mix.

### History
- Full searchable/filterable log of past sessions, samples, measurements,
  defects and images.

### Settings / Admin
- Manage lookup tables: defect types, dimensions, grade mappings, PT consumables.
- **Bulk import** production orders from CSV with column mapping (upsert by OrderID).
- Reset demo data, user and theme.

### Audit Logs
- Chronological activity trail (user, action, entity, timestamp) for compliance.
- Export to CSV.

## Tech stack

- React 18 + TypeScript + Vite
- Tailwind CSS (class-based dark mode)
- React Router
- Recharts (analytics)
- lucide-react (icons)
- Data persisted client-side in `localStorage` (seeded with realistic demo data
  on first run). No backend required to run the demo.

## Getting started

```bash
npm install
npm run dev      # start dev server (http://localhost:5173)
npm run build    # type-check + production build
npm run preview  # preview the production build
```

## Data & persistence

All data lives in the browser via a small reactive store
(`src/store/db.ts`) backed by `localStorage`. The schema and seed data live in
`src/types/index.ts` and `src/data/seed.ts`. Use **Settings → General → Reset
demo data** to restore the seed at any time.

The store is structured so the persistence layer can later be swapped for a real
backend (e.g. Supabase / Dataverse) without changing the UI: every read goes
through `useDB()` / selectors and every write through `actions.*`.
