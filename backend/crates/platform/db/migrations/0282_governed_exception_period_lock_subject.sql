-- BW-15 (LOCK lane), decisions #7 case B and #8b: a sole-holder period unlock
-- records a governed exception (PERIOD_UNLOCK_SOLE_HOLDER, SOLE_HOLDER fallback,
-- review_due_at = the 사후 검토 item) about the unlocked lock row, so
-- governed_exceptions.subject_type admits PERIOD_LOCK. Numbered head+1 of the
-- lane's base; INTEG renumbers and, when another lane widens the same CHECK,
-- keeps the union in the later migration.
SET LOCAL lock_timeout = '2s';

ALTER TABLE governed_exceptions DROP CONSTRAINT IF EXISTS governed_exceptions_subject_type_check;
ALTER TABLE governed_exceptions ADD CONSTRAINT governed_exceptions_subject_type_check
    CHECK (subject_type IN (
        'EMPLOYMENT_EVENT', 'ATTENDANCE_RECORD', 'ORG_CHANGE', 'EXIT_CASE',
        'EMPLOYEE', 'USER_ACCOUNT', 'PAYROLL_RUN', 'ORGANIZATION',
        'LEGAL_ENTITY', 'BUSINESS_REGISTRATION', 'PERIOD_LOCK'
    ));
