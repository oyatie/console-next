-- INF-03 idle sign-out (design/security-admin.md R-3; 개인정보의 안전성
-- 확보조치 기준 §6④; NIST SP 800-63B §7.2 inactivity reauthentication).
--
-- 1. last_activity_at: the last user interaction the server accepted for the
--    family. Only a client X-Last-Interaction header advances it (clamped to
--    [stored, now], written back at most once a minute), never API use, so a
--    background request cannot keep a session alive. The default stamps a new
--    family at sign-in, and existing families at migration time, so no live
--    session is cut by the deploy itself. now() is STABLE: the ADD COLUMN
--    does not rewrite the table.
-- 2. idle_timeout_minutes: a snapshot of the tenant's
--    auth.idle_timeout_minutes (settings registry, 5..60, default 30), taken
--    at refresh and on the first checked request, so the per-request check
--    reads no settings. NULL = not snapshotted yet; the check then resolves
--    the setting. The bounds live in the registry, not here.
-- 3. An idle family ends at refresh with revoked_reason = 'idle_timeout'
--    (free text, like 'logout' and 'absolute_ttl_exceeded').

ALTER TABLE public.auth_refresh_token_families
    ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN idle_timeout_minutes INTEGER,
    ADD CONSTRAINT auth_family_idle_timeout_positive
        CHECK (idle_timeout_minutes IS NULL OR idle_timeout_minutes > 0);

COMMENT ON COLUMN public.auth_refresh_token_families.last_activity_at IS
    'pd:personal — last accepted user interaction of the Account session (INF-03)';
COMMENT ON COLUMN public.auth_refresh_token_families.idle_timeout_minutes IS
    'pd:none — snapshot of auth.idle_timeout_minutes (INF-03)';
