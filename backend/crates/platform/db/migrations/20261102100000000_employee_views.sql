-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';
CREATE TABLE employee_views (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    id UUID NOT NULL,
    name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 200),
    filters JSONB NOT NULL CHECK (jsonb_typeof(filters) = 'object' AND octet_length(filters::text) <= 8192),
    PRIMARY KEY (org_id, user_id, id),
    CONSTRAINT employee_views_owner_name UNIQUE (org_id, user_id, name),
    FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE
);
ALTER TABLE employee_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_views FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_views
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON employee_views FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON employee_views TO console_rt;
COMMENT ON TABLE employee_views IS 'Caller-owned roster filters; never an authorization grant';
COMMENT ON COLUMN employee_views.org_id IS 'pd:none — tenant boundary';
COMMENT ON COLUMN employee_views.user_id IS 'pd:personal — owning account';
COMMENT ON COLUMN employee_views.id IS 'pd:none — view identifier and idempotency key';
COMMENT ON COLUMN employee_views.name IS 'pd:personal — user-supplied view name';
COMMENT ON COLUMN employee_views.filters IS 'pd:personal — roster URL filter values';
