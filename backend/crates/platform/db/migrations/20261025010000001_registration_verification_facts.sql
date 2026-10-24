-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Status polls and explicit authenticity checks establish separate facts.
CREATE OR REPLACE FUNCTION registration_verification_tier(p_id UUID, p_brn TEXT, p_known TIMESTAMPTZ DEFAULT NULL) RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH latest AS (
        SELECT DISTINCT ON (kind) kind, valid, b_stt_cd, not_registered
        FROM business_registration_checks
        WHERE registration_id = p_id AND brn_checked = p_brn
          AND (p_known IS NULL OR checked_at <= p_known)
        ORDER BY kind, checked_at DESC, id DESC
    )
    SELECT CASE
        WHEN EXISTS (SELECT 1 FROM latest WHERE kind = 'VALIDATE' AND valid = '01') THEN 'T2'
        WHEN EXISTS (SELECT 1 FROM latest WHERE kind = 'STATUS' AND b_stt_cd IS NOT NULL AND NOT not_registered) THEN 'T1'
        ELSE 'NONE'
    END
$$;
