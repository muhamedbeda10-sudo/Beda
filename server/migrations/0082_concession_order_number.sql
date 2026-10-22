-- CUS on the concession sheet is the ERP order number. Old records keep
-- their customer snapshot; no order is guessed for historical records.
ALTER TABLE concessions ADD COLUMN order_number text NOT NULL DEFAULT '' CHECK (length(order_number) <= 500);
ALTER TABLE concessions ADD COLUMN concession_by_id uuid REFERENCES users (id);
CREATE INDEX concessions_grantor_idx ON concessions (concession_by_id);
CREATE INDEX concessions_order_number_idx ON concessions (lower(btrim(order_number))) WHERE deleted_at IS NULL;
