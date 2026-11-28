-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

-- BG-11: actor-scoped personal command outcome history index for GET /api/v1/me/requests.
CREATE INDEX command_outcomes_org_actor_created_idx
    ON command_outcomes (org_id, actor_id, created_at DESC, id DESC);

-- Workflow initiator approval-line override capability flag.
ALTER TABLE workflow_definition_versions
    ADD COLUMN allow_approval_line_override BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN workflow_definition_versions.allow_approval_line_override IS
    'pd:none — whether initiators may add or swap non-required approval steps when starting a run';

-- BG-12a: 7-day governed platform group join invitations accepted by tenant ops account holders.
-- console-gate: audited-table platform_group_join_requests
CREATE TABLE platform_group_join_requests (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    group_id        UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    requested_by    UUID        NOT NULL,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'CANCELLED', 'DECLINED')),
    decided_by      UUID        NULL,
    decided_at      TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    CHECK (expires_at > requested_at),
    CHECK ((status = 'PENDING') = (decided_at IS NULL))
);

CREATE INDEX platform_group_join_requests_group_idx
    ON platform_group_join_requests (group_id, status, requested_at DESC);

ALTER TABLE platform_group_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_group_join_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON platform_group_join_requests
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON platform_group_join_requests FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON platform_group_join_requests TO console_rt;
GRANT UPDATE (status, decided_by, decided_at) ON platform_group_join_requests TO console_rt;

COMMENT ON TABLE platform_group_join_requests IS '7-day platform group join invitations requiring tenant ops account holder acceptance.';
COMMENT ON COLUMN platform_group_join_requests.org_id IS 'pd:none — invited tenant organization id';
COMMENT ON COLUMN platform_group_join_requests.id IS 'pd:none — group join invitation identifier';
COMMENT ON COLUMN platform_group_join_requests.group_id IS 'pd:none — inviting platform group id';
COMMENT ON COLUMN platform_group_join_requests.requested_by IS 'pd:personal — platform operator user id who issued the invitation';
COMMENT ON COLUMN platform_group_join_requests.requested_at IS 'pd:none — invitation creation timestamp';
COMMENT ON COLUMN platform_group_join_requests.expires_at IS 'pd:none — 7-day invitation expiration timestamp';
COMMENT ON COLUMN platform_group_join_requests.status IS 'pd:none — invitation lifecycle status (PENDING, ACCEPTED, CANCELLED, DECLINED)';
COMMENT ON COLUMN platform_group_join_requests.decided_by IS 'pd:personal — operator or tenant ops holder user id who cancelled, accepted, or declined';
COMMENT ON COLUMN platform_group_join_requests.decided_at IS 'pd:none — terminal decision timestamp';
