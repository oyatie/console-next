-- INF-07 (SEC): three audit-integrity guards in one migration.
--
-- (a) audit_events refuses TRUNCATE. The row triggers from 0003 stop UPDATE and
--     DELETE, but TRUNCATE fires no row trigger, and the owner (console_app)
--     holds TRUNCATE (the audit_chain_seals foreign key stops a plain TRUNCATE,
--     not TRUNCATE … CASCADE). A statement-level BEFORE TRUNCATE trigger closes it for
--     every role, the owner and superusers included (고시 §8③: 접속기록 must be
--     protected against forgery, alteration and deletion).
--
-- (b) console_app (the migration owner) gets lock_timeout = 2s as a role
--     default, so a migration that waits on a lock held by live traffic fails
--     fast instead of queueing every serving query behind it (INF-08 / G-18).
--     Same split as 0112/0167: superuser environments (CI, sqlx tests, local
--     dev) self-apply under a pg_authid row lock that serializes the parallel
--     test databases; production migrates AS console_app, which may set its
--     own role defaults (ALTER ROLE: "ordinary roles can only set defaults for
--     themselves"), so it self-applies too. Any other non-superuser applier
--     skips, and the assertion below fails the migration loudly.
--
-- (c) audit_access_projection: actor, time, IP, subject, action and a SHA-256
--     of the full row, for the INF-14 off-database anchor. No before_snap,
--     after_snap, user_agent or reason: the anchor proves the row existed
--     without copying personal data out of the database. The view runs with
--     the owner's rights (it must read every tenant for a daily export), so it
--     is closed to PUBLIC and console_rt here; 0031's default privileges would
--     otherwise hand console_rt a cross-tenant read. INF-14 grants SELECT to
--     its own export role.

CREATE FUNCTION audit_events_no_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: TRUNCATE is forbidden'
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER trg_audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION audit_events_no_truncate();

DO $$
BEGIN
    IF current_setting('is_superuser') = 'on' THEN
        PERFORM rolname FROM pg_authid WHERE rolname = 'console_app' FOR UPDATE;
        EXECUTE 'ALTER ROLE console_app SET lock_timeout = ''2s''';
    ELSIF current_user = 'console_app' THEN
        EXECUTE 'ALTER ROLE console_app SET lock_timeout = ''2s''';
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_db_role_setting settings
        JOIN pg_roles role ON role.oid = settings.setrole
        WHERE role.rolname = 'console_app'
          AND settings.setdatabase = 0
          AND settings.setconfig @> ARRAY['lock_timeout=2s']
    ) THEN
        RAISE EXCEPTION 'console_app lock_timeout=2s role default did not land';
    END IF;
END
$$;

CREATE VIEW audit_access_projection AS
SELECT
    event.id,
    event.org_id,
    event.actor,
    event.occurred_at,
    event.ip,
    event.action,
    event.target_type,
    event.target_id,
    encode(sha256(convert_to(to_jsonb(event)::text, 'UTF8')), 'hex') AS row_sha256
FROM audit_events AS event;

REVOKE ALL ON audit_access_projection FROM PUBLIC;
REVOKE ALL ON audit_access_projection FROM console_rt;
