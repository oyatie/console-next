-- E-S3b: a lifecycle TRANSFER may move the employee to another 사업장 of the
-- same 법인 (전근; design/legal-entities-and-workplaces §6, ED §3.9). The
-- event records the 사업장 it moves to; the employment_assignments split it
-- causes (entity's EmploymentAssignmentPort, in the event's transaction)
-- carries the event id as its command_id, which is how a rescission finds it.
-- Lane number (head+1 of hard/life/e-s3b); INTEG renumbers at merge.
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_lifecycle_events
    ADD COLUMN to_workplace_id UUID NULL,
    ADD CONSTRAINT employee_lifecycle_events_to_workplace_fk
        FOREIGN KEY (org_id, to_workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT;

COMMENT ON COLUMN employee_lifecycle_events.to_workplace_id IS 'pd:personal — 사업장 the employee moves to (전근); 개보법 제2조제1호나목 결합 식별';
