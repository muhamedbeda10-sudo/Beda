-- ============================================================================
-- §27 — Receiving: what comes in, from the warehouse's door to the quality
-- decision and back (shared/src/receiving.ts says how it flows).
--
--   • receiving_list_values — the factories that receive, the Hold reasons,
--     the units; edited under Receiving → Setup.
--   • purchase_orders, purchase_order_lines — the POs deliveries are received
--     against: typed in or imported from Excel until the purchasing system's
--     API fills them (source says which). Each line keeps what was delivered
--     against it, and of that what was accepted, rejected, is on Hold or
--     awaits QC: a rollup kept by statement triggers from the delivery notes'
--     lines, worked out again whole for the lines a statement touched (as
--     0067's rollups), so neither the screens nor the assistant sum it row by
--     row.
--   • delivery_notes — what the warehouse sent to quality: its PO, the factory
--     that received it, the day; its lines' counts by decision and its coils'
--     count kept the same way, and its state worked out from them (awaiting
--     QC, on hold, decided, closed by the warehouse).
--   • delivery_note_lines — a PO line delivered, its quantity and quality's
--     decision: accepted, partly accepted, rejected (why), hold (a reason).
--   • delivery_note_coils — the coil numbers on the supplier's paper, matched
--     with the MTC register (coils) as it fills.
--   • delivery_note_images — the supplier's papers, and each decision's photos.
--   • delivery_note_events — each note's history: sent, corrected, each
--     decision, closed, reopened. Append-only.
-- The assistant reads them as ai.purchase_order_lines, ai.delivery_notes,
-- ai.delivery_note_lines and ai.delivered_coils, in the materials domain.
-- ============================================================================

-- ---- Lists ---------------------------------------------------------------------------

CREATE TABLE receiving_list_values (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list       text NOT NULL CHECK (list IN ('factory', 'hold-reason', 'unit')),
  value      text NOT NULL CHECK (btrim(value) <> '' AND length(value) <= 120),
  position   integer NOT NULL DEFAULT 0,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX receiving_list_values_value_idx ON receiving_list_values (list, lower(btrim(value))) WHERE deleted_at IS NULL;
CREATE TRIGGER receiving_list_values_no_delete BEFORE DELETE ON receiving_list_values FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

INSERT INTO receiving_list_values (list, value, position)
SELECT 'hold-reason', v, n FROM unnest(ARRAY['Missing samples', 'Missing MTC', 'Missing documents', 'Awaiting lab test', 'Awaiting drawing or approval',
  'Dimensions to be checked', 'Other']) WITH ORDINALITY AS x(v, n)
UNION ALL SELECT 'unit', v, n FROM unnest(ARRAY['pcs', 'kg', 'ton', 'm', 'set', 'coil']) WITH ORDINALITY AS x(v, n)
-- The factories the machine register already names.
UNION ALL SELECT 'factory', f, row_number() OVER (ORDER BY f) FROM (SELECT DISTINCT btrim(factory) AS f FROM machines WHERE deleted_at IS NULL AND btrim(COALESCE(factory, '')) <> '') m;

-- ---- Purchase orders ---------------------------------------------------------------------

CREATE TABLE purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number       text NOT NULL CHECK (btrim(po_number) <> '' AND length(po_number) <= 60),
  supplier        text NOT NULL DEFAULT '' CHECK (length(supplier) <= 200),
  po_date         date,
  notes           text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'api')),
  version         integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_id   uuid REFERENCES users (id),
  created_by_name text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_id   uuid REFERENCES users (id),
  updated_by_name text NOT NULL DEFAULT '',
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES users (id)
);
-- A deleted PO's number may be used again.
CREATE UNIQUE INDEX purchase_orders_number_idx ON purchase_orders (lower(btrim(po_number)) text_pattern_ops) WHERE deleted_at IS NULL;
CREATE INDEX purchase_orders_updated_idx ON purchase_orders (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX purchase_orders_created_idx ON purchase_orders (created_at);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (lower(supplier) text_pattern_ops) WHERE deleted_at IS NULL;
CREATE INDEX purchase_orders_created_by_idx ON purchase_orders (created_by_id);
CREATE INDEX purchase_orders_updated_by_idx ON purchase_orders (updated_by_id);
CREATE INDEX purchase_orders_deleted_by_idx ON purchase_orders (deleted_by_id) WHERE deleted_by_id IS NOT NULL;
CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE purchase_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         uuid NOT NULL REFERENCES purchase_orders (id),
  line_no       integer NOT NULL CHECK (line_no BETWEEN 1 AND 999999),
  item_code     text NOT NULL CHECK (btrim(item_code) <> '' AND length(item_code) <= 120),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  drawing       text NOT NULL DEFAULT '' CHECK (length(drawing) <= 200),
  dimensions    text NOT NULL DEFAULT '' CHECK (length(dimensions) <= 500),
  quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit          text NOT NULL DEFAULT '' CHECK (length(unit) <= 30),
  notes         text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  -- What its delivery notes say, kept by refresh_po_line_rollups().
  delivered_qty numeric(14,3) NOT NULL DEFAULT 0,
  accepted_qty  numeric(14,3) NOT NULL DEFAULT 0,
  rejected_qty  numeric(14,3) NOT NULL DEFAULT 0,
  hold_qty      numeric(14,3) NOT NULL DEFAULT 0,
  pending_qty   numeric(14,3) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX purchase_order_lines_no_idx ON purchase_order_lines (po_id, line_no) WHERE deleted_at IS NULL;
CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines (po_id);
CREATE INDEX purchase_order_lines_item_idx ON purchase_order_lines (lower(btrim(item_code)) text_pattern_ops) WHERE deleted_at IS NULL;
CREATE INDEX purchase_order_lines_created_idx ON purchase_order_lines (created_at);
CREATE TRIGGER purchase_order_lines_no_delete BEFORE DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---- Delivery notes -----------------------------------------------------------------------

CREATE TABLE delivery_note_counters (
  year        integer PRIMARY KEY CHECK (year BETWEEN 1 AND 9999),
  last_number bigint NOT NULL CHECK (last_number >= 0)
);

CREATE TABLE delivery_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL UNIQUE CHECK (btrim(reference) <> ''),
  po_id           uuid NOT NULL REFERENCES purchase_orders (id),
  factory         text NOT NULL CHECK (btrim(factory) <> '' AND length(factory) <= 120),
  delivered_on    date NOT NULL,
  supplier_dn_no  text NOT NULL DEFAULT '' CHECK (length(supplier_dn_no) <= 120),
  notes           text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  -- Its lines by decision and its coils, kept by refresh_delivery_note_rollups().
  lines           integer NOT NULL DEFAULT 0,
  pending_lines   integer NOT NULL DEFAULT 0,
  hold_lines      integer NOT NULL DEFAULT 0,
  accepted_lines  integer NOT NULL DEFAULT 0,
  partial_lines   integer NOT NULL DEFAULT 0,
  rejected_lines  integer NOT NULL DEFAULT 0,
  coils           integer NOT NULL DEFAULT 0,
  closed_at       timestamptz,
  closed_by_id    uuid REFERENCES users (id),
  closed_by_name  text NOT NULL DEFAULT '',
  -- shared/receiving deliveryNoteStatus.
  status          text GENERATED ALWAYS AS (CASE WHEN closed_at IS NOT NULL THEN 'closed' WHEN pending_lines > 0 THEN 'awaiting-qc'
                                                 WHEN hold_lines > 0 THEN 'hold' ELSE 'decided' END) STORED,
  submission_id   uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  version         integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_id   uuid NOT NULL REFERENCES users (id),
  created_by_name text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_id   uuid NOT NULL REFERENCES users (id),
  updated_by_name text NOT NULL,
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES users (id)
);
CREATE INDEX delivery_notes_created_idx ON delivery_notes (created_at DESC, id DESC);
CREATE INDEX delivery_notes_delivered_idx ON delivery_notes (delivered_on DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX delivery_notes_status_idx ON delivery_notes (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX delivery_notes_po_idx ON delivery_notes (po_id);
CREATE INDEX delivery_notes_factory_idx ON delivery_notes (lower(factory)) WHERE deleted_at IS NULL;
CREATE INDEX delivery_notes_created_by_idx ON delivery_notes (created_by_id);
CREATE INDEX delivery_notes_updated_by_idx ON delivery_notes (updated_by_id);
CREATE INDEX delivery_notes_closed_by_idx ON delivery_notes (closed_by_id) WHERE closed_by_id IS NOT NULL;
CREATE INDEX delivery_notes_deleted_by_idx ON delivery_notes (deleted_by_id) WHERE deleted_by_id IS NOT NULL;
CREATE TRIGGER delivery_notes_no_delete BEFORE DELETE ON delivery_notes FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE delivery_note_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id         uuid NOT NULL REFERENCES delivery_notes (id),
  po_line_id      uuid NOT NULL REFERENCES purchase_order_lines (id),
  position        integer NOT NULL CHECK (position >= 1),
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
  notes           text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'partial', 'rejected', 'hold')),
  accepted_qty    numeric(14,3),
  rejected_qty    numeric(14,3),
  hold_reason     text NOT NULL DEFAULT '' CHECK (length(hold_reason) <= 120),
  reject_reason   text NOT NULL DEFAULT '' CHECK (length(reject_reason) <= 4000),
  decision_notes  text NOT NULL DEFAULT '' CHECK (length(decision_notes) <= 4000),
  decided_at      timestamptz,
  decided_by_id   uuid REFERENCES users (id),
  decided_by_name text NOT NULL DEFAULT '',
  version         integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, po_line_id),
  -- The quantities a decision puts on it (shared/receiving decisionQuantities).
  CONSTRAINT delivery_note_lines_quantities CHECK (CASE status
    WHEN 'pending'  THEN accepted_qty IS NULL AND rejected_qty IS NULL AND decided_at IS NULL
    WHEN 'hold'     THEN accepted_qty IS NULL AND rejected_qty IS NULL AND decided_at IS NOT NULL
    WHEN 'accepted' THEN accepted_qty = quantity AND rejected_qty = 0 AND decided_at IS NOT NULL
    WHEN 'rejected' THEN accepted_qty = 0 AND rejected_qty = quantity AND decided_at IS NOT NULL
    ELSE accepted_qty > 0 AND rejected_qty > 0 AND accepted_qty + rejected_qty = quantity AND decided_at IS NOT NULL END),
  CONSTRAINT delivery_note_lines_reasons CHECK (
    (status <> 'hold' OR btrim(hold_reason) <> '') AND (status NOT IN ('rejected', 'partial') OR btrim(reject_reason) <> ''))
);
CREATE INDEX delivery_note_lines_note_idx ON delivery_note_lines (note_id, position);
CREATE INDEX delivery_note_lines_po_line_idx ON delivery_note_lines (po_line_id);
CREATE INDEX delivery_note_lines_status_idx ON delivery_note_lines (status, created_at DESC);
CREATE INDEX delivery_note_lines_decided_idx ON delivery_note_lines (decided_at) WHERE decided_at IS NOT NULL;
CREATE INDEX delivery_note_lines_created_idx ON delivery_note_lines (created_at);
CREATE INDEX delivery_note_lines_decided_by_idx ON delivery_note_lines (decided_by_id) WHERE decided_by_id IS NOT NULL;

/** A line leaves its note only while undecided: a decision is a record. */
CREATE FUNCTION delivery_note_lines_keep_decided() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'A decided delivery line cannot be deleted'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER delivery_note_lines_keep_decided BEFORE DELETE ON delivery_note_lines FOR EACH ROW EXECUTE FUNCTION delivery_note_lines_keep_decided();

CREATE TABLE delivery_note_coils (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id     uuid NOT NULL REFERENCES delivery_notes (id),
  position    integer NOT NULL CHECK (position >= 1),
  coil_number text NOT NULL CHECK (btrim(coil_number) <> '' AND length(coil_number) <= 120),
  weight      numeric(12,3) CHECK (weight >= 0),
  heat_number text NOT NULL DEFAULT '' CHECK (length(heat_number) <= 120),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX delivery_note_coils_number_idx ON delivery_note_coils (note_id, lower(btrim(coil_number)));
-- Matched with the coil register (coils_number_key: lower(coil_number)).
CREATE INDEX delivery_note_coils_coil_idx ON delivery_note_coils (lower(btrim(coil_number)) text_pattern_ops);
CREATE INDEX delivery_note_coils_created_idx ON delivery_note_coils (created_at);

CREATE TABLE delivery_note_images (
  note_id    uuid NOT NULL REFERENCES delivery_notes (id),
  image_id   uuid NOT NULL REFERENCES images (id),
  -- A decision's photo names its line; the supplier's papers name none.
  line_id    uuid REFERENCES delivery_note_lines (id),
  position   integer NOT NULL CHECK (position >= 0),
  removed_at timestamptz,
  PRIMARY KEY (note_id, image_id)
);
CREATE INDEX delivery_note_images_image_idx ON delivery_note_images (image_id) WHERE removed_at IS NULL;
CREATE INDEX delivery_note_images_line_idx ON delivery_note_images (line_id) WHERE line_id IS NOT NULL;
CREATE TRIGGER delivery_note_images_no_delete BEFORE DELETE ON delivery_note_images FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

CREATE TABLE delivery_note_events (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id  uuid NOT NULL REFERENCES delivery_notes (id),
  -- The line it is about; a line removed while undecided leaves its events.
  line_id  uuid,
  kind     text NOT NULL CHECK (kind IN ('created', 'edited', 'decided', 'coils', 'closed', 'reopened')),
  item_code text NOT NULL DEFAULT '',
  status   text CHECK (status IN ('pending', 'accepted', 'partial', 'rejected', 'hold')),
  text     text NOT NULL DEFAULT '' CHECK (length(text) <= 4000),
  by_id    uuid REFERENCES users (id),
  by_name  text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_note_events_note_idx ON delivery_note_events (note_id, at);
CREATE INDEX delivery_note_events_by_idx ON delivery_note_events (by_id);
CREATE FUNCTION delivery_note_events_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery_note_events is append-only';
END $$;
CREATE TRIGGER delivery_note_events_keep BEFORE UPDATE OR DELETE ON delivery_note_events FOR EACH ROW EXECUTE FUNCTION delivery_note_events_keep();

-- ---- The rollups, kept as the lines and coils are written ---------------------------------------

/** The notes' counts, worked out again whole from their lines and coils. */
CREATE FUNCTION refresh_delivery_note_rollups(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM delivery_notes WHERE id = ANY (ids) ORDER BY id FOR UPDATE;
  UPDATE delivery_notes n SET
    lines = a.lines, pending_lines = a.pending, hold_lines = a.hold, accepted_lines = a.accepted, partial_lines = a.partial,
    rejected_lines = a.rejected, coils = a.coils
  FROM (
    SELECT x.id,
           (SELECT count(*) FROM delivery_note_lines l WHERE l.note_id = x.id)::integer AS lines,
           (SELECT count(*) FROM delivery_note_lines l WHERE l.note_id = x.id AND l.status = 'pending')::integer AS pending,
           (SELECT count(*) FROM delivery_note_lines l WHERE l.note_id = x.id AND l.status = 'hold')::integer AS hold,
           (SELECT count(*) FROM delivery_note_lines l WHERE l.note_id = x.id AND l.status = 'accepted')::integer AS accepted,
           (SELECT count(*) FROM delivery_note_lines l WHERE l.note_id = x.id AND l.status = 'partial')::integer AS partial,
           (SELECT count(*) FROM delivery_note_lines l WHERE l.note_id = x.id AND l.status = 'rejected')::integer AS rejected,
           (SELECT count(*) FROM delivery_note_coils c WHERE c.note_id = x.id)::integer AS coils
      FROM unnest(ids) AS x(id)
  ) a
  WHERE n.id = a.id
    AND (n.lines, n.pending_lines, n.hold_lines, n.accepted_lines, n.partial_lines, n.rejected_lines, n.coils)
        IS DISTINCT FROM (a.lines, a.pending, a.hold, a.accepted, a.partial, a.rejected, a.coils);
END
$$;

/** The PO lines' quantities, worked out again whole from the lines of the notes not deleted. */
CREATE FUNCTION refresh_po_line_rollups(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM purchase_order_lines WHERE id = ANY (ids) ORDER BY id FOR UPDATE;
  UPDATE purchase_order_lines p SET
    delivered_qty = a.delivered, accepted_qty = a.accepted, rejected_qty = a.rejected, hold_qty = a.hold, pending_qty = a.pending
  FROM (
    SELECT x.id,
           COALESCE(sum(l.quantity), 0) AS delivered,
           COALESCE(sum(l.accepted_qty), 0) AS accepted,
           COALESCE(sum(l.rejected_qty), 0) AS rejected,
           COALESCE(sum(l.quantity) FILTER (WHERE l.status = 'hold'), 0) AS hold,
           COALESCE(sum(l.quantity) FILTER (WHERE l.status = 'pending'), 0) AS pending
      FROM unnest(ids) AS x(id)
      LEFT JOIN (delivery_note_lines l JOIN delivery_notes n ON n.id = l.note_id AND n.deleted_at IS NULL) ON l.po_line_id = x.id
     GROUP BY x.id
  ) a
  WHERE p.id = a.id
    AND (p.delivered_qty, p.accepted_qty, p.rejected_qty, p.hold_qty, p.pending_qty) IS DISTINCT FROM (a.delivered, a.accepted, a.rejected, a.hold, a.pending);
END
$$;

CREATE FUNCTION delivery_note_lines_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE notes uuid[]; po_lines uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT note_id), array_agg(DISTINCT po_line_id) INTO notes, po_lines FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT note_id), array_agg(DISTINCT po_line_id) INTO notes, po_lines FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT note_id), array_agg(DISTINCT po_line_id) INTO notes, po_lines
      FROM (SELECT note_id, po_line_id FROM new_rows UNION SELECT note_id, po_line_id FROM old_rows) x;
  END IF;
  PERFORM refresh_delivery_note_rollups(notes);
  PERFORM refresh_po_line_rollups(po_lines);
  RETURN NULL;
END
$$;
CREATE TRIGGER delivery_note_lines_rollups_ins AFTER INSERT ON delivery_note_lines REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION delivery_note_lines_after_change();
CREATE TRIGGER delivery_note_lines_rollups_upd AFTER UPDATE ON delivery_note_lines REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION delivery_note_lines_after_change();
CREATE TRIGGER delivery_note_lines_rollups_del AFTER DELETE ON delivery_note_lines REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION delivery_note_lines_after_change();

CREATE FUNCTION delivery_note_coils_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE notes uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT note_id) INTO notes FROM new_rows;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT note_id) INTO notes FROM old_rows;
  ELSE
    SELECT array_agg(DISTINCT note_id) INTO notes FROM (SELECT note_id FROM new_rows UNION SELECT note_id FROM old_rows) x;
  END IF;
  PERFORM refresh_delivery_note_rollups(notes);
  RETURN NULL;
END
$$;
CREATE TRIGGER delivery_note_coils_rollups_ins AFTER INSERT ON delivery_note_coils REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION delivery_note_coils_after_change();
CREATE TRIGGER delivery_note_coils_rollups_upd AFTER UPDATE ON delivery_note_coils REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION delivery_note_coils_after_change();
CREATE TRIGGER delivery_note_coils_rollups_del AFTER DELETE ON delivery_note_coils REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION delivery_note_coils_after_change();

/** A note deleted or restored: its lines leave or come back to their PO lines' quantities. Only that change. */
CREATE FUNCTION delivery_notes_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE po_lines uuid[];
BEGIN
  SELECT array_agg(DISTINCT l.po_line_id) INTO po_lines
    FROM new_rows n JOIN old_rows o ON o.id = n.id AND (o.deleted_at IS NULL) <> (n.deleted_at IS NULL)
    JOIN delivery_note_lines l ON l.note_id = n.id;
  PERFORM refresh_po_line_rollups(po_lines);
  RETURN NULL;
END
$$;
CREATE TRIGGER delivery_notes_rollups_upd AFTER UPDATE ON delivery_notes REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION delivery_notes_after_change();

REVOKE EXECUTE ON FUNCTION refresh_delivery_note_rollups(uuid[]), refresh_po_line_rollups(uuid[]), delivery_note_lines_after_change(),
  delivery_note_coils_after_change(), delivery_notes_after_change(), delivery_note_lines_keep_decided(), delivery_note_events_keep() FROM PUBLIC;

-- ---- The bell --------------------------------------------------------------------------------
-- 'receiving': a delivery note awaits quality's decision, or quality decided one the person sent.

ALTER TABLE user_notifications DROP CONSTRAINT user_notifications_kind;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind CHECK (kind IN (
  'automation-case', 'automation-digest', 'automation-report', 'automation-stopped',
  'follow-up-assigned', 'follow-up-overdue', 'follow-up-updated',
  'task-assigned', 'task-updated', 'task-done', 'task-reopened',
  'ai-answer', 'report-shared', 'planning-alert', 'receiving'));

-- ---- Who may ------------------------------------------------------------------------------

INSERT INTO permissions (id) VALUES ('view-receiving'), ('create-delivery-note'), ('manage-purchase-orders'), ('decide-receiving'), ('manage-receiving-setup');
INSERT INTO role_permissions (role, permission) VALUES
  ('admin', 'view-receiving'), ('admin', 'create-delivery-note'), ('admin', 'manage-purchase-orders'), ('admin', 'decide-receiving'), ('admin', 'manage-receiving-setup'),
  ('supervisor', 'view-receiving'), ('supervisor', 'decide-receiving'), ('supervisor', 'manage-receiving-setup'),
  ('inspector', 'view-receiving'),
  ('warehouse', 'view-receiving'), ('warehouse', 'create-delivery-note'), ('warehouse', 'manage-purchase-orders')
ON CONFLICT DO NOTHING;

-- ---- The assistant's views ------------------------------------------------------------------------

CREATE OR REPLACE VIEW ai.purchase_order_lines AS
SELECT l.id                       AS po_line_id,
       p.id                       AS po_id,
       p.po_number,
       p.supplier,
       p.po_date,
       p.source,
       l.line_no,
       l.item_code,
       l.description,
       l.drawing,
       l.dimensions,
       l.quantity::float8         AS quantity,
       l.unit,
       l.delivered_qty::float8    AS delivered_qty,
       l.accepted_qty::float8     AS accepted_qty,
       l.rejected_qty::float8     AS rejected_qty,
       l.hold_qty::float8         AS hold_qty,
       l.pending_qty::float8      AS pending_qty,
       GREATEST(l.quantity - l.delivered_qty, 0)::float8 AS remaining_qty,
       l.notes,
       l.created_at,
       p.updated_at
  FROM purchase_order_lines l
  JOIN purchase_orders p ON p.id = l.po_id AND p.deleted_at IS NULL
 WHERE l.deleted_at IS NULL;

COMMENT ON VIEW ai.purchase_order_lines IS 'The purchase orders (POs) incoming material is received against, one row per PO line: the item ordered and how much of it was delivered, accepted, rejected, is on Hold or awaits quality''s decision (kept as the delivery notes are written: read the figures here, never sum ai.delivery_note_lines for them). Deliveries: ai.delivery_note_lines (join on po_line_id).';
COMMENT ON COLUMN ai.purchase_order_lines.po_line_id IS 'The PO line''s id = ai.delivery_note_lines.po_line_id.';
COMMENT ON COLUMN ai.purchase_order_lines.po_id IS 'The PO''s id = ai.delivery_notes.po_id.';
COMMENT ON COLUMN ai.purchase_order_lines.po_number IS 'The PO''s number as purchasing writes it (compare ignoring case).';
COMMENT ON COLUMN ai.purchase_order_lines.supplier IS 'The supplier the PO is placed with.';
COMMENT ON COLUMN ai.purchase_order_lines.po_date IS 'The PO''s day; null when not known.';
COMMENT ON COLUMN ai.purchase_order_lines.source IS 'manual (typed in) | import (the purchase orders'' Excel sheet) | api (the purchasing system).';
COMMENT ON COLUMN ai.purchase_order_lines.line_no IS 'The line''s number on the PO.';
COMMENT ON COLUMN ai.purchase_order_lines.item_code IS 'The item ordered (indexed: lower(btrim(item_code))).';
COMMENT ON COLUMN ai.purchase_order_lines.description IS 'The item''s description.';
COMMENT ON COLUMN ai.purchase_order_lines.drawing IS 'Its drawing''s number, as the PO writes it.';
COMMENT ON COLUMN ai.purchase_order_lines.dimensions IS 'Its dimensions, as the PO writes them.';
COMMENT ON COLUMN ai.purchase_order_lines.quantity IS 'The quantity ordered, in unit.';
COMMENT ON COLUMN ai.purchase_order_lines.unit IS 'pcs, kg, ton, m…';
COMMENT ON COLUMN ai.purchase_order_lines.delivered_qty IS 'Delivered on delivery notes not deleted, whatever their decision.';
COMMENT ON COLUMN ai.purchase_order_lines.accepted_qty IS 'Of what was delivered, accepted by quality (a partly accepted line''s accepted part included).';
COMMENT ON COLUMN ai.purchase_order_lines.rejected_qty IS 'Of what was delivered, rejected by quality (a partly accepted line''s rejected part included).';
COMMENT ON COLUMN ai.purchase_order_lines.hold_qty IS 'Of what was delivered, on Hold, waiting for what quality asked (samples, MTC…).';
COMMENT ON COLUMN ai.purchase_order_lines.pending_qty IS 'Of what was delivered, still awaiting quality''s decision.';
COMMENT ON COLUMN ai.purchase_order_lines.remaining_qty IS 'Ordered and not delivered yet (0 once delivered in full or more).';
COMMENT ON COLUMN ai.purchase_order_lines.notes IS 'The line''s notes.';
COMMENT ON COLUMN ai.purchase_order_lines.created_at IS 'When the line was entered (indexed).';
COMMENT ON COLUMN ai.purchase_order_lines.updated_at IS 'When the PO was last changed.';

CREATE OR REPLACE VIEW ai.delivery_notes AS
SELECT n.id                AS delivery_note_id,
       n.reference,
       n.po_id,
       p.po_number,
       p.supplier,
       n.factory,
       n.delivered_on,
       n.supplier_dn_no,
       n.status,
       n.lines,
       n.pending_lines,
       n.hold_lines,
       n.accepted_lines,
       n.partial_lines,
       n.rejected_lines,
       n.coils,
       n.notes,
       n.created_at,
       n.created_by_id,
       n.created_by_name,
       n.closed_at,
       n.closed_by_name,
       n.updated_at
  FROM delivery_notes n
  JOIN purchase_orders p ON p.id = n.po_id
 WHERE n.deleted_at IS NULL;

COMMENT ON VIEW ai.delivery_notes IS 'Deliveries of incoming material: one row per delivery note the warehouse sent to quality receiving, with its lines counted by quality''s decision (kept as they are written: read the counts here). Its lines: ai.delivery_note_lines (join on delivery_note_id); its coils: ai.delivered_coils. Filter the period on delivered_on or created_at.';
COMMENT ON COLUMN ai.delivery_notes.delivery_note_id IS 'The note''s id = ai.delivery_note_lines.delivery_note_id = ai.delivered_coils.delivery_note_id.';
COMMENT ON COLUMN ai.delivery_notes.reference IS 'The note''s number, DN-year-number: "DN-26-0012".';
COMMENT ON COLUMN ai.delivery_notes.po_id IS 'Its PO = ai.purchase_order_lines.po_id.';
COMMENT ON COLUMN ai.delivery_notes.po_number IS 'Its PO''s number.';
COMMENT ON COLUMN ai.delivery_notes.supplier IS 'Its PO''s supplier.';
COMMENT ON COLUMN ai.delivery_notes.factory IS 'The factory whose store received it (indexed: lower(factory)).';
COMMENT ON COLUMN ai.delivery_notes.delivered_on IS 'The day it reached the store (indexed).';
COMMENT ON COLUMN ai.delivery_notes.supplier_dn_no IS 'The supplier''s own delivery note number, as on its paper.';
COMMENT ON COLUMN ai.delivery_notes.status IS 'awaiting-qc (a line awaits quality''s decision) | hold (none awaits, but a line is on Hold) | decided (every line decided; the warehouse to close it) | closed (closed by the warehouse). Indexed.';
COMMENT ON COLUMN ai.delivery_notes.lines IS 'Its lines (PO lines delivered).';
COMMENT ON COLUMN ai.delivery_notes.pending_lines IS 'Lines awaiting quality''s decision.';
COMMENT ON COLUMN ai.delivery_notes.hold_lines IS 'Lines on Hold.';
COMMENT ON COLUMN ai.delivery_notes.accepted_lines IS 'Lines accepted whole.';
COMMENT ON COLUMN ai.delivery_notes.partial_lines IS 'Lines partly accepted (the rest rejected).';
COMMENT ON COLUMN ai.delivery_notes.rejected_lines IS 'Lines rejected whole.';
COMMENT ON COLUMN ai.delivery_notes.coils IS 'Coils on the supplier''s paper (ai.delivered_coils).';
COMMENT ON COLUMN ai.delivery_notes.notes IS 'The warehouse''s notes.';
COMMENT ON COLUMN ai.delivery_notes.created_at IS 'When the warehouse sent it to quality (indexed).';
COMMENT ON COLUMN ai.delivery_notes.created_by_id IS 'Who sent it = ai.users.user_id.';
COMMENT ON COLUMN ai.delivery_notes.created_by_name IS 'Who sent it.';
COMMENT ON COLUMN ai.delivery_notes.closed_at IS 'When the warehouse closed it once decided; null while open.';
COMMENT ON COLUMN ai.delivery_notes.closed_by_name IS 'Who closed it.';
COMMENT ON COLUMN ai.delivery_notes.updated_at IS 'When it was last changed.';

CREATE OR REPLACE VIEW ai.delivery_note_lines AS
SELECT l.id                    AS delivery_note_line_id,
       n.id                    AS delivery_note_id,
       n.reference,
       l.po_line_id,
       p.po_number,
       p.supplier,
       n.factory,
       n.delivered_on,
       pl.line_no              AS po_line_no,
       pl.item_code,
       pl.description,
       pl.drawing,
       pl.dimensions,
       pl.unit,
       l.quantity::float8      AS quantity,
       l.status                AS decision,
       l.accepted_qty::float8  AS accepted_qty,
       l.rejected_qty::float8  AS rejected_qty,
       l.hold_reason,
       l.reject_reason,
       l.decision_notes,
       l.decided_at,
       l.decided_by_id,
       l.decided_by_name,
       l.notes,
       l.created_at            AS received_at,
       n.status                AS note_status
  FROM delivery_note_lines l
  JOIN delivery_notes n ON n.id = l.note_id AND n.deleted_at IS NULL
  JOIN purchase_order_lines pl ON pl.id = l.po_line_id
  JOIN purchase_orders p ON p.id = n.po_id;

COMMENT ON VIEW ai.delivery_note_lines IS 'Each item delivered and quality receiving''s decision on it: one row per line of a delivery note (a PO line delivered). decision says accepted, partial, rejected, hold or pending. Filter the period on delivered_on, received_at or decided_at; join ai.delivery_notes on delivery_note_id, ai.purchase_order_lines on po_line_id.';
COMMENT ON COLUMN ai.delivery_note_lines.delivery_note_line_id IS 'The line''s id.';
COMMENT ON COLUMN ai.delivery_note_lines.delivery_note_id IS 'Its note = ai.delivery_notes.delivery_note_id.';
COMMENT ON COLUMN ai.delivery_note_lines.reference IS 'Its note''s number (DN-26-0012).';
COMMENT ON COLUMN ai.delivery_note_lines.po_line_id IS 'The PO line delivered = ai.purchase_order_lines.po_line_id.';
COMMENT ON COLUMN ai.delivery_note_lines.po_number IS 'Its PO''s number.';
COMMENT ON COLUMN ai.delivery_note_lines.supplier IS 'Its PO''s supplier.';
COMMENT ON COLUMN ai.delivery_note_lines.factory IS 'The factory that received it.';
COMMENT ON COLUMN ai.delivery_note_lines.delivered_on IS 'The day it reached the store.';
COMMENT ON COLUMN ai.delivery_note_lines.po_line_no IS 'The PO line''s number.';
COMMENT ON COLUMN ai.delivery_note_lines.item_code IS 'The item.';
COMMENT ON COLUMN ai.delivery_note_lines.description IS 'The item''s description.';
COMMENT ON COLUMN ai.delivery_note_lines.drawing IS 'The item''s drawing number.';
COMMENT ON COLUMN ai.delivery_note_lines.dimensions IS 'The item''s dimensions, as the PO writes them.';
COMMENT ON COLUMN ai.delivery_note_lines.unit IS 'The quantities'' unit.';
COMMENT ON COLUMN ai.delivery_note_lines.quantity IS 'The quantity delivered.';
COMMENT ON COLUMN ai.delivery_note_lines.decision IS 'pending (awaiting quality) | accepted | partial (accepted_qty accepted, rejected_qty rejected) | rejected | hold (waiting for what hold_reason says). Indexed.';
COMMENT ON COLUMN ai.delivery_note_lines.accepted_qty IS 'Accepted: the whole quantity when accepted, the accepted part when partial, 0 when rejected; null while pending or on Hold.';
COMMENT ON COLUMN ai.delivery_note_lines.rejected_qty IS 'Rejected: the whole quantity when rejected, the rest when partial, 0 when accepted; null while pending or on Hold.';
COMMENT ON COLUMN ai.delivery_note_lines.hold_reason IS 'Why it is on Hold, from the list (Missing samples, Missing MTC, Missing documents…); '''' otherwise.';
COMMENT ON COLUMN ai.delivery_note_lines.reject_reason IS 'Why it was rejected (rejected or partial), in quality''s words.';
COMMENT ON COLUMN ai.delivery_note_lines.decision_notes IS 'Quality''s notes on its decision.';
COMMENT ON COLUMN ai.delivery_note_lines.decided_at IS 'When its current decision was given (indexed); null while pending. Earlier decisions of a Hold decided later are in the note''s history on the screen.';
COMMENT ON COLUMN ai.delivery_note_lines.decided_by_id IS 'Who gave it = ai.users.user_id.';
COMMENT ON COLUMN ai.delivery_note_lines.decided_by_name IS 'Who gave it.';
COMMENT ON COLUMN ai.delivery_note_lines.notes IS 'The warehouse''s note on the line.';
COMMENT ON COLUMN ai.delivery_note_lines.received_at IS 'When the warehouse sent it to quality (indexed).';
COMMENT ON COLUMN ai.delivery_note_lines.note_status IS 'Its note''s state: awaiting-qc | hold | decided | closed.';

CREATE OR REPLACE VIEW ai.delivered_coils AS
SELECT c.id                AS delivered_coil_id,
       n.id                AS delivery_note_id,
       n.reference,
       p.po_number,
       p.supplier,
       n.factory,
       n.delivered_on,
       c.coil_number,
       c.weight::float8    AS weight,
       c.heat_number,
       (r.id IS NOT NULL)  AS has_mtc,
       r.grade,
       r.thickness::float8 AS thickness,
       c.created_at
  FROM delivery_note_coils c
  JOIN delivery_notes n ON n.id = c.note_id AND n.deleted_at IS NULL
  JOIN purchase_orders p ON p.id = n.po_id
  LEFT JOIN coils r ON lower(r.coil_number) = lower(btrim(c.coil_number)) AND r.deleted_at IS NULL;

COMMENT ON VIEW ai.delivered_coils IS 'The coils delivered, as the supplier''s paper lists them on each delivery note, matched with the coil register (the MTC register: coils read from the mill''s certificate). has_mtc false = the coil''s certificate has not come yet: the list to chase. Join ai.coils on coil_number.';
COMMENT ON COLUMN ai.delivered_coils.delivered_coil_id IS 'The row''s id.';
COMMENT ON COLUMN ai.delivered_coils.delivery_note_id IS 'Its note = ai.delivery_notes.delivery_note_id.';
COMMENT ON COLUMN ai.delivered_coils.reference IS 'Its note''s number.';
COMMENT ON COLUMN ai.delivered_coils.po_number IS 'Its PO''s number.';
COMMENT ON COLUMN ai.delivered_coils.supplier IS 'Its PO''s supplier.';
COMMENT ON COLUMN ai.delivered_coils.factory IS 'The factory that received it.';
COMMENT ON COLUMN ai.delivered_coils.delivered_on IS 'The day it reached the store.';
COMMENT ON COLUMN ai.delivered_coils.coil_number IS 'The coil''s number as on the paper = ai.coils.coil_number (compare ignoring case; indexed).';
COMMENT ON COLUMN ai.delivered_coils.weight IS 'Its weight on the paper, kg; null when not given.';
COMMENT ON COLUMN ai.delivered_coils.heat_number IS 'Its heat number on the paper.';
COMMENT ON COLUMN ai.delivered_coils.has_mtc IS 'The coil is in the coil register (its MTC was read); false while its certificate is still to come.';
COMMENT ON COLUMN ai.delivered_coils.grade IS 'Its grade from the coil register; null without its MTC.';
COMMENT ON COLUMN ai.delivered_coils.thickness IS 'Its thickness from the coil register, mm; null without its MTC.';
COMMENT ON COLUMN ai.delivered_coils.created_at IS 'When it was entered (indexed).';

-- The materials domain holds them, with the coil register and the lab (0033, 0086).
DO $$
DECLARE
  role text := current_database() || '_ai_materials';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
    EXECUTE format('GRANT SELECT ON ai.purchase_order_lines, ai.delivery_notes, ai.delivery_note_lines, ai.delivered_coils TO %I', role);
  END IF;
END $$;
