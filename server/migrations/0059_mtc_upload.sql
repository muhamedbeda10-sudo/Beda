-- ============================================================================
-- MTC — mill test certificates read into the coil register.
--
--   • users.mtc_upload — the administrator allows a person, one by one, to
--     upload a certificate and save the coils read from it. It is a
--     permission of its own: no role carries it, and it gives nothing of the
--     AI assistant (Claude reads the certificate with the company's key, but
--     the person needs no access to the assistant's chat). Everyone signed in
--     sees the coil register's table; only this saves into it from a
--     certificate.
--   • coils_created_idx — the register's table can list the newest coils
--     first: those a certificate has just added.
--
-- The certificate's PDF is not kept: its number goes into each coil's notes.
-- ============================================================================

ALTER TABLE users ADD COLUMN mtc_upload boolean NOT NULL DEFAULT false;

CREATE INDEX coils_created_idx ON coils (created_at DESC) WHERE deleted_at IS NULL;
