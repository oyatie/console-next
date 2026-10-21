SET LOCAL lock_timeout = '2s';
CREATE INDEX command_outcomes_recovery_idx ON command_outcomes (org_id,deadline,id) WHERE state='PROCESSING';
