-- ============================================================================
-- §14 — permissions: what each role may open and do, changeable by
-- administrators, and each person's own differences from their role.
--
--   • permissions — the catalog's ids (shared/src/permissions.ts). A
--     permission added later is inserted here by its own migration.
--   • role_permissions — each role's set; seeded with where each role stood
--     until now (the capability table that was in the code), the
--     administrators' "manage admin data" split into the screens it opened.
--   • user_permissions — a person's override: a permission given (granted)
--     or taken away (NOT granted). Only differences are kept, so a person
--     follows every later change to their role in the rest.
--   • user_has_permission(user, permission) — the same rule in SQL, for the
--     server's queries that pick people by what they may do (who hears a
--     chat message, who receives notices). The AI assistant's owner (ADMIN+)
--     holds every permission.
-- ============================================================================

CREATE TABLE permissions (
  id text PRIMARY KEY
);

INSERT INTO permissions (id) VALUES
  ('view-inspections'), ('view-history'), ('view-order-sheet'), ('view-dashboard'), ('view-mtc'), ('view-coil-search'),
  ('use-chat'), ('manage-configuration'), ('import-data'), ('manage-users'), ('view-audit-log'), ('manage-notices'),
  ('view-release-notes'), ('record-inspection'), ('edit-open-session'), ('edit-closed-session'), ('view-all-sessions'),
  ('delete-session'), ('delete-sample'), ('delete-note'), ('export-records'), ('view-inspector-ranking'),
  ('view-all-follow-ups'), ('purge-audit-logs'), ('read-notices'), ('manage-chat');

CREATE TABLE role_permissions (
  role            user_role NOT NULL,
  permission      text NOT NULL REFERENCES permissions (id),
  PRIMARY KEY (role, permission)
);

INSERT INTO role_permissions (role, permission)
SELECT 'viewer'::user_role, p FROM unnest(ARRAY['view-inspections', 'view-history', 'view-order-sheet', 'view-dashboard', 'view-mtc', 'view-all-sessions']) AS p
UNION ALL
SELECT 'inspector', p FROM unnest(ARRAY['view-inspections', 'view-history', 'view-mtc', 'view-coil-search', 'use-chat', 'record-inspection', 'edit-open-session', 'read-notices']) AS p
UNION ALL
SELECT 'supervisor', p FROM unnest(ARRAY['view-inspections', 'view-history', 'view-order-sheet', 'view-mtc', 'view-coil-search', 'use-chat', 'view-audit-log',
                                         'record-inspection', 'edit-open-session', 'edit-closed-session', 'view-all-sessions', 'export-records',
                                         'view-all-follow-ups', 'read-notices']) AS p
UNION ALL
SELECT 'admin', id FROM permissions;

CREATE TABLE user_permissions (
  user_id         uuid NOT NULL REFERENCES users (id),
  permission      text NOT NULL REFERENCES permissions (id),
  granted         boolean NOT NULL,
  updated_by_id   uuid REFERENCES users (id),
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

CREATE FUNCTION user_has_permission(p_user uuid, p_permission text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM ai_owner o WHERE o.user_id = p_user)
      OR COALESCE(
           (SELECT up.granted FROM user_permissions up WHERE up.user_id = p_user AND up.permission = p_permission),
           EXISTS (SELECT 1 FROM users u JOIN role_permissions rp ON rp.role = u.role AND rp.permission = p_permission WHERE u.id = p_user)
         )
$$;
