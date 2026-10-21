-- contract-of: 20261013142447372
-- Pending: not in migrations/, so it does not ship now. Move it into
-- migrations/ under a new version only in a release whose previous release
-- already writes 근태 through console_attendance_domain::close and unlocks
-- through the governed unlock_in_tx (the one that shipped
-- 20261013142447372). That release also removes the app.period_unlock
-- set_config from platform/db/src/period_lock/unlock.rs.
SET LOCAL lock_timeout = '2s';

-- The domain rule, decided under the close and period-lock advisory keys, is
-- then the only closed-month guard; no trigger repeats it.
DROP TRIGGER trg_attendance_entries_closed_month ON attendance_entries;
DROP FUNCTION attendance_entries_closed_month();

-- An approved unlock reopens a closed month, so an unlock no longer has to
-- keep an org close's lock in force. Lock rows are immutable apart from the
-- one-shot unlock (0107) and cannot be deleted, so the lock side has nothing
-- left to guard; the close side keeps 0188's reference check, reading "in
-- force" as period_lock_effective() like the rest of the unlock flow.
DROP TRIGGER trg_period_lock_attendance_close_consistent ON period_locks;
CREATE OR REPLACE FUNCTION attendance_month_close_lock_consistent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    checked_close attendance_month_closes%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN NULL;
    END IF;
    SELECT * INTO checked_close
      FROM attendance_month_closes
     WHERE org_id = NEW.org_id AND id = NEW.id;
    IF NOT FOUND OR checked_close.branch_id IS NOT NULL THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM period_locks p
         WHERE p.id = checked_close.period_lock_id AND p.org_id = checked_close.org_id
           AND p.domain = 'payroll'
           AND p.period_start = checked_close.month
           AND p.period_end = (checked_close.month + INTERVAL '1 month - 1 day')::date
           AND period_lock_effective(p)
    ) THEN
        RAISE EXCEPTION 'attendance org close requires an active same-org payroll lock for its exact month'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;
