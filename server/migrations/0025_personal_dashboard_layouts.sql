-- ============================================================================
-- 0025 — a dashboard layout per administrator (§15).
--
-- The layout saved in app_settings ('dashboard-layout') becomes the fixed
-- default: everyone without a layout of their own reads it, and nothing in
-- the application writes it any more. An administrator who arranges the
-- board keeps the arrangement here, for themselves only. Going back to the
-- default clears the row's layout and keeps the row, so nothing is deleted.
-- ============================================================================

CREATE TABLE dashboard_user_layouts (
  user_id     uuid PRIMARY KEY REFERENCES users(id),
  -- NULL: this person follows the default.
  layouts     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_user_layouts_shape CHECK (layouts IS NULL OR jsonb_typeof(layouts) = 'object')
);
CREATE TRIGGER dashboard_user_layouts_updated_at BEFORE UPDATE ON dashboard_user_layouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER dashboard_user_layouts_no_delete BEFORE DELETE ON dashboard_user_layouts FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();
