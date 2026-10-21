-- BW-17 answer kinds (governance S10 prerequisites): ACCESS_EXPLANATION, the
-- 접속기록 review's 소명 요청 (S7), always named to the account it asks; and
-- POLICY_QUESTION, S5's 규정 검토 필요 to the rule owner. The named assignee
-- answers an answer kind (APPLY or DECLINE with a note); it changes no record.
-- 0264 is frozen, so the kind list widens here; nothing is removed.

ALTER TABLE change_requests DROP CONSTRAINT IF EXISTS change_requests_kind_check;
ALTER TABLE change_requests ADD CONSTRAINT change_requests_kind_check
    CHECK (kind IN (
        'PROFILE_CORRECTION', 'IDENTITY_REVIEW', 'ACCESS_REQUEST',
        'SCOPE_ACTION', 'OTHER', 'ACCESS_EXPLANATION', 'POLICY_QUESTION'
    ));

ALTER TABLE change_requests ADD CONSTRAINT change_requests_explanation_names_subject
    CHECK (
        kind <> 'ACCESS_EXPLANATION'
        OR (subject_type = 'USER_ACCOUNT' AND assignee_user_id = subject_id)
    );

-- Classification is unchanged and stays on 0264's markers (the PDC gate
-- forbids a second marker): kind pd:none, decided_by and decision_note
-- pd:personal (decision_note also holds an answer kind's 소명).
