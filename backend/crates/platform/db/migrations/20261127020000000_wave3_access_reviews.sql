-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Create periodic access review tables with forced tenant RLS and realtime invalidation.
-- contract-of: 0301
-- console-gate: audited-table access_reviews
-- console-gate: audited-table access_review_items
-- console-gate: audited-table access_review_decisions
SET LOCAL lock_timeout = '2s';

CREATE TABLE access_reviews (
    org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id           UUID        NOT NULL DEFAULT gen_random_uuid(),
    period       TEXT        NOT NULL CHECK (period ~ '^[0-9]{4}-Q[1-4]$'),
    state        TEXT        NOT NULL CHECK (state IN ('OPEN', 'COMPLETE')),
    due_at       TIMESTAMPTZ NOT NULL,
    frozen_count INTEGER     NOT NULL CHECK (frozen_count >= 0),
    started_by   UUID        NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_by UUID        NULL,
    completed_at TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, period),
    FOREIGN KEY (started_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (completed_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

CREATE TABLE access_review_items (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    review_id       UUID        NOT NULL,
    grant_id        UUID        NOT NULL,
    account_id      UUID        NOT NULL,
    account_name    TEXT        NOT NULL,
    employee_number TEXT        NULL,
    unit_name       TEXT        NULL,
    role_id         UUID        NOT NULL,
    role_name_ko    TEXT        NOT NULL,
    scope_kind      TEXT        NOT NULL,
    scope_label     TEXT        NOT NULL,
    valid_from      TIMESTAMPTZ NOT NULL,
    valid_to        TIMESTAMPTZ NULL,
    last_used_at    TIMESTAMPTZ NULL,
    signals         TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, review_id, grant_id),
    FOREIGN KEY (org_id, review_id) REFERENCES access_reviews (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

CREATE INDEX access_review_items_review_idx ON access_review_items (org_id, review_id, account_name, id);

CREATE TABLE access_review_decisions (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id          UUID        NOT NULL DEFAULT gen_random_uuid(),
    review_id   UUID        NOT NULL,
    item_id     UUID        NOT NULL,
    decision    TEXT        NOT NULL CHECK (decision IN ('KEEP', 'REVOKE')),
    reason_code TEXT        NULL,
    reason_note TEXT        NULL CHECK (reason_note IS NULL OR char_length(reason_note) <= 1000),
    decided_by  UUID        NOT NULL,
    decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at  TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, review_id, item_id),
    FOREIGN KEY (org_id, review_id) REFERENCES access_reviews (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, item_id) REFERENCES access_review_items (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (decided_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

ALTER TABLE access_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON access_reviews
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID);
CREATE TRIGGER trg_access_reviews_org_immutable
    BEFORE UPDATE ON access_reviews
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE access_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_review_items FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON access_review_items
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID);
CREATE TRIGGER trg_access_review_items_org_immutable
    BEFORE UPDATE ON access_review_items
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE access_review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_review_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON access_review_decisions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID);
CREATE TRIGGER trg_access_review_decisions_org_immutable
    BEFORE UPDATE ON access_review_decisions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

REVOKE ALL PRIVILEGES ON access_reviews FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE (state, completed_by, completed_at) ON access_reviews TO console_rt;

REVOKE ALL PRIVILEGES ON access_review_items FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON access_review_items TO console_rt;

REVOKE ALL PRIVILEGES ON access_review_decisions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE (decision, reason_code, reason_note, decided_by, decided_at, applied_at) ON access_review_decisions TO console_rt;

INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id)
VALUES
    ('access_review', 'access_review.start', 'access_review', false),
    ('access_review', 'access_review.decide', 'access_review', false),
    ('access_review', 'access_review.complete', 'access_review', false)
ON CONFLICT DO NOTHING;

ALTER TABLE api_idempotency_keys
    DROP CONSTRAINT IF EXISTS api_idempotency_keys_operation_check,
    ADD CONSTRAINT api_idempotency_keys_operation_check CHECK (operation IN (
        'users.create', 'access.invites.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'hr.exit_case.bulk_create', 'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve', 'period_lock.unlock_reject',
        'employee.correction.bulk', 'appointment_notice.issue', 'tenant.domain.request', 'platform.tenant.rename',
        'certificate.issue', 'certificate.void', 'certificate.reissue',
        'platform.tenant.ops_recovery.open', 'platform.tenant.ops_recovery.approve',
        'platform.tenant.ops_recovery.issue', 'platform.tenant.ops_recovery.cancel',
        'employee_import.rollback', 'access_log_review.start', 'access_log_review.finding',
        'access_log_review.complete',
        'access_review.start', 'access_review.decide', 'access_review.complete'
    )) NOT VALID;
ALTER TABLE api_idempotency_keys
    VALIDATE CONSTRAINT api_idempotency_keys_operation_check;

COMMENT ON TABLE access_reviews IS 'Periodic quarterly access review cycles over tenant role grants';
COMMENT ON COLUMN access_reviews.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_reviews.id IS 'pd:none — access review cycle id';
COMMENT ON COLUMN access_reviews.period IS 'pd:none — quarterly review period key (YYYY-Qn)';
COMMENT ON COLUMN access_reviews.state IS 'pd:none — OPEN or COMPLETE lifecycle state';
COMMENT ON COLUMN access_reviews.due_at IS 'pd:none — target completion timestamp';
COMMENT ON COLUMN access_reviews.frozen_count IS 'pd:none — number of grants frozen at cycle start';
COMMENT ON COLUMN access_reviews.started_by IS 'pd:personal — account id that started the review cycle';
COMMENT ON COLUMN access_reviews.started_at IS 'pd:none — cycle start timestamp';
COMMENT ON COLUMN access_reviews.completed_by IS 'pd:personal — account id that signed off the review cycle';
COMMENT ON COLUMN access_reviews.completed_at IS 'pd:none — cycle completion timestamp';

COMMENT ON TABLE access_review_items IS 'Frozen snapshot of active role grants captured when an access review cycle starts';
COMMENT ON COLUMN access_review_items.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_review_items.id IS 'pd:none — frozen review item id';
COMMENT ON COLUMN access_review_items.review_id IS 'pd:none — owning access_reviews id';
COMMENT ON COLUMN access_review_items.grant_id IS 'pd:none — source access_grants id';
COMMENT ON COLUMN access_review_items.account_id IS 'pd:personal — reviewed account holder id';
COMMENT ON COLUMN access_review_items.account_name IS 'pd:personal — account display name captured at freeze';
COMMENT ON COLUMN access_review_items.employee_number IS 'pd:personal — employee number captured at freeze';
COMMENT ON COLUMN access_review_items.unit_name IS 'pd:none — organizational unit label captured at freeze';
COMMENT ON COLUMN access_review_items.role_id IS 'pd:none — reviewed access_roles id';
COMMENT ON COLUMN access_review_items.role_name_ko IS 'pd:none — role title captured at freeze';
COMMENT ON COLUMN access_review_items.scope_kind IS 'pd:none — grant scope kind';
COMMENT ON COLUMN access_review_items.scope_label IS 'pd:none — human-readable scope label';
COMMENT ON COLUMN access_review_items.valid_from IS 'pd:none — grant start timestamp';
COMMENT ON COLUMN access_review_items.valid_to IS 'pd:none — grant end timestamp';
COMMENT ON COLUMN access_review_items.last_used_at IS 'pd:personal — last observed audit activity timestamp of the account';
COMMENT ON COLUMN access_review_items.signals IS 'pd:none — review risk signal codes';

COMMENT ON TABLE access_review_decisions IS 'Reviewer KEEP or REVOKE decisions recorded for frozen access review items';
COMMENT ON COLUMN access_review_decisions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_review_decisions.id IS 'pd:none — decision row id';
COMMENT ON COLUMN access_review_decisions.review_id IS 'pd:none — owning access_reviews id';
COMMENT ON COLUMN access_review_decisions.item_id IS 'pd:none — reviewed access_review_items id';
COMMENT ON COLUMN access_review_decisions.decision IS 'pd:none — KEEP or REVOKE verdict';
COMMENT ON COLUMN access_review_decisions.reason_code IS 'pd:none — structured reason code for the decision';
COMMENT ON COLUMN access_review_decisions.reason_note IS 'pd:personal — reviewer note explaining the decision';
COMMENT ON COLUMN access_review_decisions.decided_by IS 'pd:personal — reviewer account id';
COMMENT ON COLUMN access_review_decisions.decided_at IS 'pd:none — decision timestamp';
COMMENT ON COLUMN access_review_decisions.applied_at IS 'pd:none — timestamp when revocation was applied upon cycle sign-off';
