-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Requests on todos: requester, due date and return, with a tenant-scoped requester FK; own todos keep NULLs.
-- contract-of: 0108
SET LOCAL lock_timeout = '2s';

-- A todo with a requester is a request the owner was asked to do. Every check
-- admits the NULLs an own todo carries, so the previous release keeps writing.
ALTER TABLE todos ADD COLUMN assigned_by_user_id UUID;
ALTER TABLE todos ADD COLUMN due_on DATE;
ALTER TABLE todos ADD COLUMN returned_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN return_note TEXT;

ALTER TABLE todos ADD CONSTRAINT todos_requester_tenant
    FOREIGN KEY (assigned_by_user_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT;
ALTER TABLE todos ADD CONSTRAINT todos_requester_not_owner
    CHECK (assigned_by_user_id IS DISTINCT FROM owner_user_id);
ALTER TABLE todos ADD CONSTRAINT todos_due_on_request
    CHECK (due_on IS NULL OR assigned_by_user_id IS NOT NULL);
-- A request closes once: done or sent back, never both.
ALTER TABLE todos ADD CONSTRAINT todos_returned_request_open
    CHECK (returned_at IS NULL OR (assigned_by_user_id IS NOT NULL AND NOT done));
ALTER TABLE todos ADD CONSTRAINT todos_return_note_with_return
    CHECK ((return_note IS NULL) = (returned_at IS NULL));
ALTER TABLE todos ADD CONSTRAINT todos_return_note_length
    CHECK (return_note IS NULL OR char_length(btrim(return_note)) BETWEEN 1 AND 200);

-- Backs the requester's list, newest first.
CREATE INDEX idx_todos_requester
    ON todos (org_id, assigned_by_user_id, created_at DESC, id DESC)
    WHERE (assigned_by_user_id IS NOT NULL);

COMMENT ON COLUMN todos.assigned_by_user_id IS 'pd:personal — the account that asked the owner; null for the owner''s own todo';
COMMENT ON COLUMN todos.due_on IS 'pd:personal — row of owner_user_id; the day the requester asked for';
COMMENT ON COLUMN todos.returned_at IS 'pd:personal — row of owner_user_id; when the owner sent the request back';
COMMENT ON COLUMN todos.return_note IS 'pd:personal,undeclared — free text the owner wrote when sending it back';
