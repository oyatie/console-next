-- Expand only; released migrations are immutable.
-- att-closed-month-unlock (P0): an approved period unlock reopens a closed 근태
-- month until it re-locks. Whether a month takes writes is an attendance rule
-- (console_attendance_domain::close), decided in the write's transaction after
-- the same advisory keys the close and the re-lock take.
SET LOCAL lock_timeout = '2s';

-- 0358 refused every entry in a closed month and never read the unlock. The
-- trigger stays as the database's own guard for any writer that skips the
-- domain rule; it now reads the unlock the same way
-- (console_attendance_domain::close::month_state): a closed month refuses
-- while any payroll lock window over it is in force (period_lock_effective, the
-- newest row of each window), and takes the write while an unlocked window
-- covers the whole month. A writer through the domain holds the payroll
-- period-lock key whenever it touches a closed month, and now() is fixed per
-- transaction, so this reads the lock state the domain decided on. Dropping it
-- is the contract, backend/crates/platform/db/pending/
-- 20261013142447372_attendance_closed_month_unlock.contract.sql.
CREATE OR REPLACE FUNCTION attendance_entries_closed_month() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    first_day CONSTANT DATE := date_trunc('month', NEW.work_date)::date;
    last_day CONSTANT DATE := (date_trunc('month', NEW.work_date) + INTERVAL '1 month - 1 day')::date;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM attendance_month_closes c
         WHERE c.org_id = NEW.org_id AND c.month = first_day
           AND (c.branch_id IS NULL OR c.branch_id IN (
               SELECT w.default_branch_id FROM employment_assignments a
                 JOIN workplaces w ON w.org_id = a.org_id AND w.id = a.workplace_id
                WHERE a.org_id = NEW.org_id AND a.employee_id = NEW.employee_id AND a.superseded_at IS NULL
                  AND a.valid_from <= NEW.work_date AND (a.valid_to IS NULL OR a.valid_to > NEW.work_date)))
    ) THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        WITH windows AS (
            SELECT DISTINCT ON (p.period_start, p.period_end)
                   p.period_start, p.period_end, period_lock_effective(p) AS in_force
              FROM period_locks p
             WHERE p.org_id = NEW.org_id AND p.domain = 'payroll'
               AND p.period_start <= last_day AND p.period_end >= first_day
             ORDER BY p.period_start, p.period_end, p.locked_at DESC
        )
        SELECT 1 WHERE EXISTS (SELECT 1 FROM windows WHERE in_force)
                OR NOT EXISTS (SELECT 1 FROM windows
                                WHERE period_start <= first_day AND period_end >= last_day)
    ) THEN
        RAISE EXCEPTION 'entry_month_closed' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

-- 0188 refuses, at COMMIT, an unlock of a payroll lock an org close
-- references. The governed unlock (console_platform_db::period_lock::
-- unlock_in_tx) now reopens such a month, so it names the row it unlocks in
-- the transaction-local app.period_unlock and this guard takes that one row.
-- Every other writer, the previous release's identical unlock included, never
-- sets it and is refused as 0188 refuses it. The rest is 0188's body
-- verbatim. Dropping the lock side is the contract (same pending file).
CREATE OR REPLACE FUNCTION attendance_month_close_lock_consistent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    checked_close attendance_month_closes%ROWTYPE;
    lock_org_id UUID;
    lock_domain TEXT;
    lock_start DATE;
    lock_end DATE;
    lock_unlocked_at TIMESTAMPTZ;
    changed_lock_id UUID;
    changed_lock_org_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'attendance_month_closes' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN NULL;
        END IF;
        SELECT * INTO checked_close
          FROM attendance_month_closes
         WHERE org_id = NEW.org_id AND id = NEW.id;
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
        IF checked_close.branch_id IS NOT NULL THEN
            RETURN NULL;
        END IF;
        SELECT org_id, domain, period_start, period_end, unlocked_at
          INTO lock_org_id, lock_domain, lock_start, lock_end, lock_unlocked_at
          FROM period_locks
         WHERE id = checked_close.period_lock_id AND org_id = checked_close.org_id;
        IF NOT FOUND
           OR lock_domain <> 'payroll'
           OR lock_start <> checked_close.month
           OR lock_end <> (checked_close.month + INTERVAL '1 month - 1 day')::date
           OR lock_unlocked_at IS NOT NULL
        THEN
            RAISE EXCEPTION 'attendance org close requires an active same-org payroll lock for its exact month'
                USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
        changed_lock_id := OLD.id;
        changed_lock_org_id := OLD.org_id;
    ELSE
        changed_lock_id := NEW.id;
        changed_lock_org_id := NEW.org_id;
    END IF;
    IF TG_OP = 'UPDATE' AND current_setting('app.period_unlock', true) = changed_lock_id::text THEN
        RETURN NULL;
    END IF;
    FOR checked_close IN
        SELECT * FROM attendance_month_closes
         WHERE period_lock_id = changed_lock_id
           AND org_id = changed_lock_org_id
    LOOP
        SELECT org_id, domain, period_start, period_end, unlocked_at
          INTO lock_org_id, lock_domain, lock_start, lock_end, lock_unlocked_at
          FROM period_locks
         WHERE id = checked_close.period_lock_id AND org_id = checked_close.org_id;
        IF NOT FOUND
           OR lock_domain <> 'payroll'
           OR lock_start <> checked_close.month
           OR lock_end <> (checked_close.month + INTERVAL '1 month - 1 day')::date
           OR lock_unlocked_at IS NOT NULL
        THEN
            RAISE EXCEPTION 'attendance org close requires an active same-org payroll lock for its exact month'
                USING ERRCODE = '23514';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;
