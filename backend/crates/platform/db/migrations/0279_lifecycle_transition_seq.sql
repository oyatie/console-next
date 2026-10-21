-- LOCK lane (delivery plan §4.1): a monotonic order for the object lifecycle
-- transition log. Numbered head+1 of the lane's base (0255); INTEG renumbers.
--
-- The log was ordered `occurred_at DESC, id DESC`. `occurred_at` is the
-- transaction start time, so it ties inside one transaction and can step
-- backwards when the host clock is adjusted (a VM clock resync), and `id` is a
-- random UUID, so the tie-break is arbitrary. "Newest transition into this
-- state" (the maker-checker lookup) then picked the wrong row now and then:
-- platform-db::lifecycle_walks_document_chain_and_gates_dispose failed about one
-- run in many. `seq` is assigned at INSERT from one sequence, so it orders the
-- appends exactly as they happened.
--
-- Adding an identity column rewrites the table and numbers the existing rows in
-- their physical order; the append-only UPDATE/DELETE triggers do not fire on a
-- rewrite. Identity sequences need no grant beyond INSERT on the table.
SET LOCAL lock_timeout = '2s';

ALTER TABLE object_lifecycle_transitions
    ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;
COMMENT ON COLUMN object_lifecycle_transitions.seq IS
    'pd:none — append order of the transition log, structural';

-- Every reader orders by seq now; the occurred_at index has no reader left.
DROP INDEX idx_object_lifecycle_transitions_history;
CREATE INDEX idx_object_lifecycle_transitions_seq
    ON object_lifecycle_transitions (org_id, lifecycle_id, seq DESC);
