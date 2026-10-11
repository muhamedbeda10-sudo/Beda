# QC System · Inspection Recorder

A web application for recording and tracking quality-control inspections in a
manufacturing environment. It covers the full inspection lifecycle — from
selecting a production order and starting a session, through recording samples,
dimensional measurements, visual defects, coils and photos, to closing the
session and reviewing results in History and the Audit Log.

Works on **desktop and mobile** (responsive, touch-friendly, light + dark mode).

## Architecture

```
┌──────────────────────────────┐        ┌────────────────────────────────────┐
│  client/  React + Vite SPA   │  HTTP  │  server/  Node 20 · Express 5 API  │
│  React Query · Tailwind      │ ─────▶ │  zod validation · JWT auth         │
└──────────────────────────────┘        │  served from the same origin       │
              ▲                         └──────────────┬─────────────┬───────┘
              │ built client is served                 │ SQL         │ bytes
              │ by the API in production               ▼             ▼
                                        ┌──────────────────┐ ┌──────────────────┐
                                        │ PostgreSQL 16    │ │ Azure Blob       │
                                        │ (Azure Flexible  │ │ Storage          │
                                        │  Server)         │ │ (photos)         │
                                        └──────────────────┘ └──────────────────┘
```

| Folder     | What it is                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------- |
| `shared/`  | Domain model, business rules (§8) and the HTTP contract. Pure TypeScript, used by both sides. |
| `client/`  | The React application. Talks to the API only through `src/lib/api.ts`.                       |
| `server/`  | The API: PostgreSQL schema (`migrations/`), routes (`src/modules/`), auth, image storage.    |
| `infra/`   | Azure infrastructure as a Bicep template (database, storage, App Service).                  |
| `scripts/` | `package.mjs` assembles the folder that Azure App Service runs.                              |

**Hosting:** one Azure App Service (Linux, Node 20) runs the API and serves the
built client; **Azure Database for PostgreSQL Flexible Server** holds the data;
**Azure Blob Storage** holds the photos. Setup is in
[`AZURE_SETUP.md`](./AZURE_SETUP.md) (English + العربية).

## Roles

| Role         | Can                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------- |
| `inspector`  | Record inspections; correct measurements/defects in **open** sessions.                     |
| `supervisor` | Also correct **closed** sessions, delete (soft) sessions, read the audit log.               |
| `admin`      | Also manage master data, bulk imports, user accounts and audit purges.                     |

The **first account created becomes the admin**. Afterwards, set
`AUTH_ALLOW_SELF_REGISTRATION=false` and create accounts from **Admin → Users**.

## Features

- **Order lines** — the ERP exports one row per (order, item, machine), each
  with its own Order ID. That row is what an inspection is recorded against:
  the order number repeats across the lines of one order.
- **Inspections (home)** — open sessions grouped by machine; New Inspection
  flow (machine → the orders on it → the order's items on that machine →
  confirm the starting quantity); continue, close (with final quantity) or
  delete a session; a Hold-defect badge.
- **Inspection wizard** — Setup (drawing, coils picked from the coil register
  with an immediate grade warning), Dimensions (the item's rows for this
  machine — a machine-specific row overrides the general one — next to the
  item's reference photos; nominal ± tolerance with automatic Pass / Warning /
  Fail), Defects (the machine's list, bilingual EN/AR names, quantity,
  mandatory disposition, photos), Paint Sample step (work centres 7, 11, 48),
  PT / Weld step (22, 58: test frequency > 5 %, consumable lots), Review &
  **atomic save** with the sample quantity taken — the whole sample is written
  in one transaction or not at all. Drafts survive reloads and dead Wi-Fi.
- **Grade check** — coil grades are compared with the order's expected grade
  (with transitive equivalences); a mismatch must be acknowledged and is audited.
- **History** — the latest sessions → samples → the full record, with audited
  corrections and optimistic concurrency (a stale edit is rejected).
- **Coil search** — coil → sample → order → customer traceability.
- **PDI documents** — pre-delivery photos attached to an order.
- **Installable** — a Progressive Web App: "Install" on Android and desktop
  Chrome/Edge, "Add to Home Screen" from Safari's share sheet on iPhone and
  iPad. The shell is precached so it opens instantly; the API is never cached.
- **Administration** (the gear, far right) — **Configuration**: the machine
  register, item dimensions (by item code, optionally per machine), master
  dimensions, reference images (single or bulk upload), machine defects, grade
  mappings, PT consumables, each with its sheet importer where the ERP exports
  one; **Data import**: order lines, coils and the ERP's production task
  record (the production written against the order sheet: one row per order
  line per working day, matched on Order ID + Record ID; rows missing from a
  later file are kept), CSV or Excel, with a preview (idempotent upsert on the
  business key); **Users**; **Audit log** — every
  create / update / delete / acknowledge / purge, field by field, with who and
  when, append-only and undeletable at the database.

## Data integrity — enforced by the database, not just the UI

- Nothing is hard-deleted: every evidence table has a trigger that refuses
  `DELETE`. Removing a record sets `deleted_at`.
- The audit log cannot be edited; the only permitted change is marking an
  entry purged, which is itself an audit entry.
- A defect cannot exist without a disposition; a PT record cannot have a test
  frequency ≤ 5 % or a missing consumable lot (CHECK constraints).
- Sample saves are idempotent on a client-generated submission id: a double
  tap or a retried request never creates a duplicate.
- Session and sample numbering happens under a row lock, so two inspectors
  saving at once cannot collide.

## Getting started (local)

Requirements: Node 20+, PostgreSQL 14+ (16 recommended).

```bash
npm install

# database + config
createdb qc_dev                                # or any name
cp .env.example server/.env                    # then edit DATABASE_URL and JWT_SECRET

npm run dev        # API on :8080 and client on :5173 (the client proxies /api)
```

Open <http://localhost:5173>, create the first account (it becomes the admin).
Set `SEED_DEMO_DATA=true` in `server/.env` before the first sign-in to load
demo machines, defects, dimensions and a few orders.

Other commands:

```bash
npm run lint       # type-check every workspace
npm test           # shared rule tests + API integration tests (needs TEST_DATABASE_URL, default qc_test)
npm run build      # build client + bundle the API
npm run db:migrate # apply pending migrations and exit
npm run db:seed    # load demo master data into an empty database
```

The API tests run against a real PostgreSQL database and reset it (they drop
and recreate the `public` and `ai` schemas), so point `TEST_DATABASE_URL` at a
throwaway database. They never call Anthropic: the AI assistant's tests use a
scripted stand-in for the model.

## Configuration

All settings are environment variables, documented in [`.env.example`](./.env.example).
The important ones:

| Variable                          | Purpose                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`                    | PostgreSQL connection string (`?sslmode=require` on Azure).           |
| `JWT_SECRET`                      | Signs access tokens. 32+ random characters.                            |
| `IMAGE_STORAGE_DRIVER`            | `azure-blob` in production, `local` for development.                  |
| `AZURE_STORAGE_CONNECTION_STRING` | Blob storage connection string when the driver is `azure-blob`.       |
| `AUTH_ALLOW_SELF_REGISTRATION`    | Whether the login screen offers "Create account" (first account always). |
| `RUN_MIGRATIONS_ON_START`         | Apply pending SQL migrations when the API starts.                     |
| `FACTORY_TIMEZONE`                | IANA zone used to derive the shift (A/B/C) from the time of a sample.  |
| `SEED_DEMO_DATA`                  | Seed demo master data into an empty database on first admin sign-in.  |
| `ANTHROPIC_API_KEY`               | Optional. The AI assistant's key — normally set in the app instead (Administration → AI assistant), stored encrypted. Set here, it wins. |
| `AI_OWNER_USERNAME`               | Optional, default `beda`. The account that owns the AI assistant, pinned once (see below). |
| `AUTOMATIONS_ENABLED`             | Optional, default `true`. Runs the automations engine (watches, scheduled reports, follow-up deadlines) in this instance. Several instances may all run it: a run is claimed in the database, so none runs twice. |

## Database

The schema lives in `server/migrations/*.sql` and is applied in order by the
API on start (or by `npm run db:migrate`). Migrations are forward-only; add a
new numbered file rather than editing an applied one.

Main tables: `users`, `auth_sessions`, `machines`, `production_orders`,
`coils`, `item_dimension_order`,
`item_reference_images`, `work_center_defects`, `grade_mappings`,
`pt_consumables`, `images`, `inspection_sessions`, `inspection_samples`,
`dimension_results`, `defect_results`, `sample_coils`, `paint_samples`,
`pt_records`, `pdi_documents`, `production_task_records` (the ERP's
production task record, one row per order line per working day, joined to
`production_orders` on `line_key`), the image junction tables, and
`audit_log`.

The AI assistant belongs to one owner: the live, active account named by
`AI_OWNER_USERNAME`, pinned in `ai_owner` the first time it exists and never
moved through the app afterwards (a rename or a changed setting only logs a
warning; recovery, should that account go, is a database operation). Only the
owner sees its settings, key, access list and costs; to anyone else those
endpoints answer 404 and the assistant's audit entries are not in the log.
The owner gives the assistant to people one by one (`ai_access`): the data
domains each may ask about, the model and effort, and a personal monthly cap.

The assistant reads the record only through the views in schema `ai`, and the
database enforces the domains: migrations 0033 and 0040 create one role
without LOGIN per domain (`<database>_ai_base`, `_ai_inspection`,
`_ai_orders`, `_ai_materials`, `_ai_audit`, `_ai_production` — the last for
the ERP's production task record, `ai.production_task_records`, the child of
the order sheet joined on `line_key`), each holding exactly its views, and
every start creates one LOGIN role per combination of domains
(`<database>_ai_r_10100` and so on, one bit per domain in that order,
thirty-one in all; 0040 retired the fifteen four-bit ones), a member of the
base and of its domains only, with a password derived from `JWT_SECRET` and
the role's name. A question runs as the
asker's combination; every query runs read-only and is rolled back. The
assistant's own records are the `ai_*` tables (conversations, usage for the
caps, the encrypted API key, the owner and the access list), which no reader
role can read.

**Automations.** The owner, and the people the owner allows
(`ai_access.automations`), can ask the assistant in plain words to keep an eye
on something or to send a report regularly. The assistant writes it as a
proposal, tried once against the data; nothing runs until a person presses
Activate. A watch is a read-only query the API runs every few minutes (at
least five) — around the clock, or only within the hours of the factory day
and on the days it was given — without the model, under its creator's current
domains: each row is a case, and each case fires once (`ai_automation_hits`).
A scheduled report
runs its queries at a factory-time hour and the model writes a short summary
on top, counted against its creator's cap. An automation can only tell people
— an alert in the bell (`user_notifications`) and a message from the "QC
Automations" account, which cannot sign in (`users.is_system`) — and open
follow-ups (`follow_ups`, with an assignee, a deadline, comments and one
escalation when overdue); a session with an open follow-up shows "Needs
review" in History. It never changes the record. Runs are claimed with
`FOR UPDATE SKIP LOCKED`, so several instances never run one twice; one that
fails five times in a row stops itself and tells its creator and the owner.

## API

All endpoints are under `/api` and answer JSON. Authentication is a Bearer
access token (15 min, kept in memory by the client) plus an httpOnly refresh
cookie (30 days, revocable per device). The full request/response contract is
in `shared/src/api.ts`.

| Area     | Endpoints                                                                                   |
| -------- | ------------------------------------------------------------------------------------------- |
| Auth     | `POST /auth/register` `POST /auth/login` `POST /auth/refresh` `POST /auth/logout` `GET /auth/me` |
| Users    | `GET/POST /users` `PATCH /users/:id` (admin)                                                 |
| Master   | `GET/POST /master/:kind` `PUT/DELETE /master/:kind/:id` `POST /master/{item-dimension-order,machines,work-center-defects}/{import,existing-keys}` |
| Orders   | `GET /orders?search=&machine=&orderNumber=` `GET /orders/numbers?machine=` `GET /orders/:id` `GET /orders/:id/history` `POST /orders/import` `POST /orders/existing-keys` |
| Coils    | `GET /coils?search=` `GET /coils/usage` `POST /coils/import`                                |
| Production record | `POST /production-records/import` `POST /production-records/existing-keys` `DELETE /production-records` `GET /production-records/summary` (admin) |
| Sessions | `GET /sessions/open` `GET /sessions/history` `POST /sessions` `GET /sessions/:id/wizard` `POST /sessions/:id/close` `DELETE /sessions/:id` `POST /sessions/:id/samples` |
| Samples  | `GET /samples/:id` `PATCH /samples/dimensions/:id` `PATCH /samples/defects/:id`             |
| Images   | `POST /images` (multipart) `GET /images?ids=` `GET /images/:id/content`                      |
| PDI      | `GET/POST /pdi`                                                                             |
| Audit    | `GET /audit` `GET /audit/stats` `POST /audit/purge`                                         |
| Health   | `GET /health`                                                                               |
