-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — add a caller-scoped read projection; historical ledger rows and writers are unchanged.
SET LOCAL lock_timeout = '2s';

-- Ordinary tenant audit readers use the caller's RLS and exclude both kinds of
-- records served by the separately cleared, access-audited CEO stream.
CREATE VIEW ordinary_audit_events WITH (security_invoker = true) AS
SELECT a.*
FROM audit_events a
WHERE NOT (
    a.target_type = 'audit_stream' AND a.target_id = 'ceo_covert_audit'
    AND a.action IN ('audit_stream.ceo_read', 'audit_stream.access_log_read')
)
AND NOT EXISTS (
    SELECT 1 FROM audit_stream_event_labels l
    WHERE l.org_id = a.org_id AND l.audit_event_id = a.id
      AND l.stream_key = 'ceo_covert_audit' AND l.sensitivity = 'CEO_COVERT'
);

GRANT SELECT ON ordinary_audit_events TO console_rt;

-- Historical review notes can reference an event that was later classified.
CREATE VIEW ordinary_audit_register WITH (security_invoker = true) AS
SELECT a.*
FROM ordinary_audit_events a
WHERE a.action <> 'access_log_review.finding' OR NOT EXISTS (
    SELECT 1 FROM audit_stream_event_labels l
    WHERE l.org_id = a.org_id AND l.audit_event_id::text = a.after_snap->>'event_id'
      AND l.stream_key = 'ceo_covert_audit' AND l.sensitivity = 'CEO_COVERT'
);

GRANT SELECT ON ordinary_audit_register TO console_rt;
