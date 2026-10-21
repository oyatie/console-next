-- UX-R3 SCOPE (catalog governance-22, people-self-38): 「권한 요청」 is a record,
-- not a mailto. A refused screen files one request per (account, screen)
-- while it is open; the holders of 권한 관리 see and close it (done or
-- declined), and the requester may withdraw it. Expand-only.
--
-- Lane number (SCOPE range 0330-0334); INTEG renumbers.
SET LOCAL lock_timeout = '2s';

CREATE TABLE access_requests (
    org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id           UUID        NOT NULL DEFAULT gen_random_uuid(),
    requested_by UUID        NOT NULL,
    screen       TEXT        NOT NULL CHECK (char_length(btrim(screen)) BETWEEN 1 AND 200),
    reason_code  TEXT        NOT NULL CHECK (reason_code IN ('NEW_DUTY', 'COVER', 'NEEDED_NOW', 'OTHER')),
    note         TEXT        NULL CHECK (note IS NULL OR char_length(note) <= 500),
    status       TEXT        NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN', 'DONE', 'DECLINED', 'WITHDRAWN')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_by    UUID        NULL,
    closed_at    TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (requested_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (closed_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT access_requests_other_note CHECK (reason_code <> 'OTHER' OR note IS NOT NULL),
    CONSTRAINT access_requests_close_shape CHECK (
        (status = 'OPEN') = (closed_at IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL))
);
CREATE UNIQUE INDEX access_requests_open_uniq
    ON access_requests (org_id, requested_by, lower(btrim(screen))) WHERE status = 'OPEN';
CREATE INDEX access_requests_open_idx ON access_requests (org_id, created_at) WHERE status = 'OPEN';

ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON access_requests FROM PUBLIC, console_rt;
CREATE POLICY org_isolation ON access_requests
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_access_requests_org_immutable BEFORE UPDATE ON access_requests
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
GRANT SELECT, INSERT ON access_requests TO console_rt;
GRANT UPDATE (status, closed_by, closed_at) ON access_requests TO console_rt;

COMMENT ON TABLE access_requests IS 'Requests for access filed from a refused screen (governance-22)';
COMMENT ON COLUMN access_requests.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_requests.id IS 'pd:none — request id';
COMMENT ON COLUMN access_requests.requested_by IS 'pd:personal — account that asked';
COMMENT ON COLUMN access_requests.screen IS 'pd:none — the refused screen (route key)';
COMMENT ON COLUMN access_requests.reason_code IS 'pd:none — NEW_DUTY | COVER | NEEDED_NOW | OTHER';
COMMENT ON COLUMN access_requests.note IS 'pd:personal — free text from the requester';
COMMENT ON COLUMN access_requests.status IS 'pd:none — OPEN | DONE | DECLINED | WITHDRAWN';
COMMENT ON COLUMN access_requests.created_at IS 'pd:none — filed at';
COMMENT ON COLUMN access_requests.closed_by IS 'pd:personal — account that closed it';
COMMENT ON COLUMN access_requests.closed_at IS 'pd:none — closed at';
