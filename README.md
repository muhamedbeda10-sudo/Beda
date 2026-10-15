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

## Roles and permissions

What a person may open (a **screen**) and do (an **action**) is a set of
permissions (`shared/src/permissions.ts`): their role's set, with their own
differences. Roles start as below; administrators change each role's set under
**Users → Roles**, and one person's under the shield beside their name.

| Role         | Starts with                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `viewer`     | Inspections, History, Access, Dashboard, MTC — reading only; no chat, no notices.                  |
| `inspector`  | Inspections, History, MTC, Coil search, Chat; record inspections; correct **open** sessions.        |
| `supervisor` | Also Access and the Audit log; correct **closed** sessions; export to Excel; everyone's follow-ups. |
| `admin`      | Everything: configuration, imports, users and permissions, notices, deletions, audit purges.        |

- **ADMIN+** is the AI assistant's owner (`AI_OWNER_USERNAME`): every
  permission, always; nobody else changes that account or removes it, and the
  administrators' own set is ADMIN+'s alone to change.
- Nobody gives more than they hold: one manages only accounts whose
  permissions one holds, gives only permissions one has, and never changes
  one's own role or permissions.
- A screen is enforced on the server on every endpoint it reads, not only
  hidden. Permissions are read from the database on every request
  (`role_permissions`, `user_permissions`, and `user_has_permission()` for
  queries that pick people), so a change applies at once.

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
- **MTC** (last tab, everyone) — the material registers as tables: **Coils**,
  **Welding wire** (by batch) and **Mesh wire** (by cast + diameter); search,
  supplier and type filters, newest first. **Upload MTC**: Claude reads the
  supplier's certificate (its PDF, photos of its pages, or its Excel sheet read
  into text on the device) on the server, tells which register it belongs to
  and lists every item with that register's fields; the person reviews and
  corrects each row (doubtful values marked), chooses per registered item
  whether to overwrite it, and saves in one audited transaction. The PDF is
  never stored; the certificate number goes into the notes. Who may upload is
  set by the AI assistant's owner per person (AI settings → Who can use it →
  "Can upload MTC certificates"; the assistant may be off for them). Each
  reading is logged with its cost in the owner's Activity and counts toward
  the assistant's and the person's monthly caps, on the model and effort the
  owner sets for certificates under Models (Sonnet, high, by default); a
  reading with too many unsure values is read again on Opus by itself
  (`mtc_readings.reread`, switchable). The PT step suggests registered
  welding wire batches.
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
`coils`, `welding_wires`, `mesh_wires`, `mtc_readings`, `item_dimension_order`,
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
domains each may ask about, their permissions, and a personal monthly cap.

The model and effort are set by what the assistant is doing, not by who asks
(AI settings → Models, stored with the assistant's settings in
`app_settings`): a chat question's level — simple, analysis, deep, or with
files — and each other action (reading a certificate, a conversation's title,
a report's adjustable-period template, a scheduled report's summary), each
"Auto" (the recommended model and effort, `AI_ACTIONS` in `shared/src/ai.ts`)
or a fixed choice. In Auto chat mode a short call to Haiku
(`server/src/ai/router.ts`, 8-second deadline) gives each question without
files its level and a reason, stored on the turn (`ai_turns.level`,
`level_reason`) and shown in Activity; any failure gives the analysis level.
The router's call is billed with the question. A person's cap must allow one
question on the cheapest model a question may run on.

The assistant reads the record only through the views in schema `ai`, and the
database enforces the domains: migrations 0033 and 0041 create one role
without LOGIN per domain (`<database>_ai_base`, `_ai_inspection`,
`_ai_orders`, `_ai_materials`, `_ai_audit`, `_ai_production` — the last for
the ERP's production task record, `ai.production_task_records`, the child of
the order sheet joined on `line_key`), each holding exactly its views, and
every start creates one LOGIN role per combination of domains
(`<database>_ai_r_10100` and so on, one bit per domain in that order,
thirty-one in all; 0041 retired the fifteen four-bit ones), a member of the
base and of its domains only, with a password derived from `JWT_SECRET` and
the role's name. A question runs as the
asker's combination; every query runs read-only and is rolled back. The
assistant's own records are the `ai_*` tables (conversations, usage for the
caps, the encrypted API key, the owner and the access list), which no reader
role can read.

An answer is written on the server, not by the request that asked for it
(`server/src/ai/answerRunner.ts`): closing the page only stops watching, and
only Stop (`POST /api/ai/conversations/:id/stop`) ends it early. The instance
writing an answer says so every few seconds on its turn (`ai_turns.runner`,
`heartbeat_at`); one that has not for 30 s was lost with its instance, and
another instance takes it over and continues it from its last stored step —
a step is stored before its tools run, so it is finished from there, each
tool once, never asked of the model again. Its model calls and running time
are counted on the turn, so its limits hold across hand-overs. A stopping
instance hands its answers back at once. An answer begun by the version
before (no heartbeat) is never continued: it is left to that version while
it may still be writing it, and closed as cut off once past its limit
(16 minutes). An answer that ends while nobody
has it on screen puts an alert in the bell (kind `ai-answer`), which is
pushed like any other.

**Push notifications.** At the first tap in the app the browser asks to
allow notifications (browsers ask only after a tap); once allowed, the device
is subscribed at every sign-in, until the person turns it off in the account
panel (or the phone's menu). The device subscribes with the
server's VAPID key (made once and kept in `app_settings`, unless
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` are set) and is stored in
`push_subscriptions`. Triggers queue every new bell alert and chat message in
`push_events`; an in-process dispatcher (`server/src/push/`) works out who is
told, by the same rules the app shows them by, and pushes through the browser's
push service, so they arrive with the device's sound even with the app closed.
Notices aimed at everyone, roles or named people are pushed once, on their
first day. Signing out removes the device's subscription. On iPhone and iPad
the app must be added to the Home Screen first. `PUSH_ENABLED=false` turns it
all off.

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
| Users    | `GET/POST /users` `PATCH/DELETE /users/:id` `PUT /users/:id/permissions` `GET /users/roles` `PUT /users/roles/:role` (Users screen); `GET /users/directory` (Users, Notices or Dashboard) |
| Master   | `GET/POST /master/:kind` `PUT/DELETE /master/:kind/:id` `POST /master/{item-dimension-order,machines,work-center-defects}/{import,existing-keys}` |
| Orders   | `GET /orders?search=&machine=&orderNumber=` `GET /orders/numbers?machine=` `GET /orders/:id` `GET /orders/:id/history` `POST /orders/import` `POST /orders/existing-keys` |
| Coils    | `GET /coils?search=` `GET /coils/usage` `POST /coils/import`                                |
| MTC      | `POST /mtc/extract` (multipart PDF → SSE) `GET /mtc/:kind/table` `GET /mtc/:kind/options` `POST /mtc/:kind/existing` `POST /mtc/:kind/save` (`kind`: coils, welding-wire, mesh-wire; reading and saving need the MTC permission, `ai_access.mtc`) |
| Production record | `POST /production-records/import` `POST /production-records/existing-keys` `DELETE /production-records` `GET /production-records/summary` (admin) |
| Sessions | `GET /sessions/open` `GET /sessions/history` `POST /sessions` `GET /sessions/:id/wizard` `POST /sessions/:id/close` `DELETE /sessions/:id` `POST /sessions/:id/samples` |
| Samples  | `GET /samples/:id` `PATCH /samples/dimensions/:id` `PATCH /samples/defects/:id`             |
| Images   | `POST /images` (multipart) `GET /images?ids=` `GET /images/:id/content`                      |
| PDI      | `GET/POST /pdi`                                                                             |
| Audit    | `GET /audit` `GET /audit/stats` `POST /audit/purge`                                         |
| Health   | `GET /health`                                                                               |
