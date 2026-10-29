-- §7 — deciding a Hold is its own right, apart from correcting a session: an
-- inspector gives a defect on Hold its decision even after the session closed,
-- without being able to correct anything else in it. Starts with whoever
-- records inspections and up; administrators change it under Users → Roles.
INSERT INTO permissions (id) VALUES ('decide-holds');
INSERT INTO role_permissions (role, permission) VALUES
  ('inspector', 'decide-holds'), ('supervisor', 'decide-holds'), ('admin', 'decide-holds')
ON CONFLICT DO NOTHING;
