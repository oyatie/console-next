-- BW-29 (decisions D0.1, D0.2): the step-up kind bundle and the
-- eligible-second-person fact, as one migration. Numbered head+1 of the lane's
-- base; INTEG renumbers it at the batch merge (tools/integ/renumber-migrations.sh).
-- Design: W0 N4 (hard/found/bw29 drafts/specs/bw29.md).
--
-- Part A is the concurrency-plan §3 "Step-up CHECK (0144)" shared artifact: all
-- ten new kinds land here once and no lane re-ALTERs it. The Rust half
-- (webauthn MobileStepUpActionKind) lists the same twelve kinds.
-- Part B is the trigger-fed grant ledger and second_person_candidates(); the
-- identity adapter's fact builder calls it (owner decision: the fact is owned
-- by identity). It reads governed_exceptions, so it orders after BW-06 (0250).
--
-- No seed rows. Policy values (min grant age, demotion lookback) are
-- parameters resolved by the caller (plan D2); none is a literal here.
-- Freshness stays the single-use ceremony + PasskeySettings.ceremony_ttl.
SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- Part A. Step-up kinds, payload-hash binding, assertion record.
-- ===========================================================================
-- 1. Widen the 0144 kind set. Three constraints carry the list: the column
--    CHECK on action_kind, the column CHECK on reason_key, and the pair CHECK.
--    Legacy pairs are unchanged; each new kind's reason key is derived
--    (passkey_step_up_<kind lower>), so catalog keys never drift from kinds.
ALTER TABLE auth_webauthn_ceremony_bindings
    DROP CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check,
    DROP CONSTRAINT auth_webauthn_ceremony_bindings_reason_key_check,
    DROP CONSTRAINT auth_webauthn_ceremony_bindings_check;

-- payload_hash: lowercase hex SHA-256 of the canonical payload the step-up
-- authorizes (spec §3.2). Same text shape as governed_exceptions.fingerprint, so
-- EXCEPTION_DECIDE binds the fingerprint itself and no lane hashes twice.
ALTER TABLE auth_webauthn_ceremony_bindings
    ADD COLUMN payload_hash TEXT NULL CHECK (payload_hash IS NULL OR payload_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE auth_webauthn_ceremony_bindings
    ADD CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check CHECK (action_kind IN (
        'APPROVAL_DECISION', 'POLL_VOTE',
        'EXIT_CONFIRM', 'EXIT_RESCIND', 'ELEVATED_GRANT', 'PERIOD_UNLOCK', 'IDENTITY_MERGE',
        'EXCEPTION_DECIDE', 'SETTINGS_CHANGE', 'CREDENTIAL_RESET', 'TENANT_OFFBOARD',
        'OPERATOR_RECOVERY'
    )),
    ADD CONSTRAINT auth_webauthn_ceremony_bindings_check CHECK (
        (action_kind = 'APPROVAL_DECISION' AND reason_key = 'operations_passkey_approval_decision'
            AND payload_hash IS NULL)
        OR (action_kind = 'POLL_VOTE' AND reason_key = 'operations_passkey_poll_vote'
            AND payload_hash IS NULL)
        OR (action_kind NOT IN ('APPROVAL_DECISION', 'POLL_VOTE')
            AND reason_key = 'passkey_step_up_' || lower(action_kind)
            AND payload_hash IS NOT NULL
            AND replay_attempt IS NULL)
    );

COMMENT ON COLUMN auth_webauthn_ceremony_bindings.payload_hash IS
    'pd:none — SHA-256 hex of the canonical payload a BW-29 step-up kind authorizes; NULL only for the two legacy mobile kinds';

-- ---------------------------------------------------------------------------
-- 2. step_up_assertions: the record a governed act points at.
--    step_up_assertion_id (governed_exceptions, attestations, period locks,
--    exit cases, settings overrides) := step_up_assertions.ceremony_id.
--    Written once, in the transaction that verifies the assertion
--    (verify_assertion_in_tx already resolves the credential and arms the org).
--    No FK to auth_webauthn_ceremonies: ceremonies are transient auth state and
--    the evidence must outlive their cleanup. The binding columns are copied.
--    user_id is a logical ref too (accounts are retired, not deleted), so the
--    empty-tenant removal (0228), which deletes users before organizations, is
--    never blocked by it. The org FK cascades: the evidence of an erased tenant
--    goes with it, on both removal paths (the force sweep only takes RESTRICT
--    children, and the empty-tenant path sweeps none).
CREATE TABLE step_up_assertions (
    ceremony_id      UUID        PRIMARY KEY,
    org_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id          UUID        NOT NULL,
    credential_row_id UUID       NOT NULL,
    action_kind      TEXT        NOT NULL CHECK (action_kind NOT IN ('APPROVAL_DECISION', 'POLL_VOTE')),
    object_id        UUID        NOT NULL,
    payload_hash     TEXT        NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    user_verified    BOOLEAN     NOT NULL CHECK (user_verified),
    asserted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ceremony_id, org_id)
);

-- Shared-authenticator lookups compare credential rows of two assertions.
CREATE INDEX step_up_assertions_org_object_idx ON step_up_assertions (org_id, object_id, action_kind);

ALTER TABLE step_up_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_up_assertions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON step_up_assertions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_step_up_assertions_org_immutable BEFORE UPDATE ON step_up_assertions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

-- Insert-only evidence: no UPDATE, no DELETE for the serving role.
REVOKE ALL PRIVILEGES ON step_up_assertions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON step_up_assertions TO console_rt;

COMMENT ON TABLE step_up_assertions IS 'BW-29 verified step-up assertion bound to (kind, object, payload hash); the referent of every step_up_assertion_id';
COMMENT ON COLUMN step_up_assertions.ceremony_id IS 'pd:none — the consumed authentication ceremony; value of step_up_assertion_id elsewhere';
COMMENT ON COLUMN step_up_assertions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN step_up_assertions.user_id IS 'pd:personal — user who asserted the passkey; logical ref, survives account removal';
COMMENT ON COLUMN step_up_assertions.credential_row_id IS 'pd:none — auth_webauthn_credentials.id that asserted; logical ref, survives credential removal';
COMMENT ON COLUMN step_up_assertions.action_kind IS 'pd:none — step-up kind (spec §3.1)';
COMMENT ON COLUMN step_up_assertions.object_id IS 'pd:none — the request row the step-up authorizes';
COMMENT ON COLUMN step_up_assertions.payload_hash IS 'pd:none — SHA-256 hex of the canonical payload';
COMMENT ON COLUMN step_up_assertions.user_verified IS 'pd:none — WebAuthn UV flag; always true';
COMMENT ON COLUMN step_up_assertions.asserted_at IS 'pd:none — verification time';

-- ---------------------------------------------------------------------------
-- 3. SECOND_PERSON_SHARED_AUTHENTICATOR (decisions D0.2). Exact credential
--    identity only: credential_id is UNIQUE platform-wide and AAGUID is a model
--    id (two identical company keys share it), so an AAGUID rule would turn a
--    real second person into a sole-holder fallback. No pair (either id NULL,
--    e.g. a SECOND_PERSON request carries no requester step-up) -> false: the
--    rule is about a pair. Both ids given but a row missing -> true (fail
--    closed; the decider re-runs the step-up). The same id twice -> true.
-- ponytail: no device-binding signal exists yet; add a device id comparison
-- here when a device registry lands (BW-24 idle sign-out or later).
CREATE FUNCTION step_up_shared_authenticator(p_first UUID, p_second UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT p_first IS NOT NULL AND p_second IS NOT NULL AND COALESCE((
        SELECT a.credential_row_id = b.credential_row_id
        FROM step_up_assertions a, step_up_assertions b
        WHERE a.ceremony_id = p_first AND b.ceremony_id = p_second
          AND a.org_id = b.org_id
    ), true)
$$;
REVOKE ALL ON FUNCTION step_up_shared_authenticator(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION step_up_shared_authenticator(UUID, UUID) TO console_rt;

-- ===========================================================================
-- Part B. The eligible-second-person fact (decisions D0.2).
-- Why a ledger: users.roles has no grant time or grantor, user_role_assignments
-- rows are DELETEd on removal, and users has no creator. D0.2 needs all three.
-- The ledger is written by triggers, so app paths and fixtures both feed it.
-- Actor attribution reads app.current_actor (new GUC, set next to
-- app.current_org by the identity adapter; follow-up). A missing GUC records
-- NULL and never raises: fixtures insert users everywhere.
-- ===========================================================================
-- The org FK cascades: every user insert writes ledger rows, so a RESTRICT FK
-- would make every tenant non-empty to the 0228 empty-tenant removal. An
-- erased tenant's grant history goes with it.
CREATE TABLE authz_grant_ledger (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL,
    grant_kind  TEXT        NOT NULL CHECK (grant_kind IN ('ACCOUNT', 'SYSTEM_ROLE', 'POLICY_ROLE')),
    grant_ref   TEXT        NOT NULL CHECK (char_length(grant_ref) BETWEEN 1 AND 100),
    event       TEXT        NOT NULL CHECK (event IN ('GRANTED', 'REVOKED', 'NOTICE_DELIVERED')),
    actor_id    UUID        NULL,
    source      TEXT        NOT NULL CHECK (source IN ('TRIGGER', 'BACKFILL', 'NOTIFIER')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (grant_kind <> 'ACCOUNT' OR (grant_ref = 'account' AND event = 'GRANTED')),
    CHECK (event <> 'NOTICE_DELIVERED' OR source IN ('NOTIFIER', 'BACKFILL')),
    CHECK (source <> 'NOTIFIER' OR event = 'NOTICE_DELIVERED')
);
CREATE INDEX authz_grant_ledger_lookup_idx
    ON authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, occurred_at DESC);
CREATE INDEX authz_grant_ledger_revoked_idx
    ON authz_grant_ledger (org_id, occurred_at) WHERE event = 'REVOKED';

-- 1. Backfill BEFORE RLS. Best-known times: ura.created_at is exact; system
--    roles only have users.created_at (a lower bound, one-time). Backfilled
--    grants are grandfathered as notified.
INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, actor_id, source, occurred_at)
SELECT u.org_id, u.id, 'ACCOUNT', 'account', 'GRANTED', NULL::uuid, 'BACKFILL', u.created_at FROM users u
UNION ALL
SELECT u.org_id, u.id, 'SYSTEM_ROLE', r, e, NULL, 'BACKFILL', u.created_at
FROM users u CROSS JOIN unnest(u.roles) r CROSS JOIN (VALUES ('GRANTED'), ('NOTICE_DELIVERED')) ev(e)
UNION ALL
SELECT a.org_id, a.user_id, 'POLICY_ROLE', a.role_id::text, e, a.assigned_by, 'BACKFILL', a.created_at
FROM user_role_assignments a CROSS JOIN (VALUES ('GRANTED'), ('NOTICE_DELIVERED')) ev(e);

ALTER TABLE authz_grant_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz_grant_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON authz_grant_ledger
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
-- The serving role may only append notice deliveries (BW-34's notifier).
CREATE POLICY notice_only_insert ON authz_grant_ledger AS RESTRICTIVE FOR INSERT TO console_rt
    WITH CHECK (event = 'NOTICE_DELIVERED' AND source = 'NOTIFIER');
REVOKE ALL PRIVILEGES ON authz_grant_ledger FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON authz_grant_ledger TO console_rt;

-- 2. Triggers. SECURITY DEFINER (owner = migration applier) so the serving
--    role needs no INSERT for GRANTED/REVOKED rows.
CREATE FUNCTION authz_grant_ledger_actor() RETURNS UUID
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('app.current_actor', true), '')::uuid $$;

-- Tenant force-remove deletes users and assignments; it must not append
-- REVOKED rows for an org that is being erased (its ledger rows cascade). The
-- empty-tenant removal may append them; the org delete cascades them too.
CREATE FUNCTION authz_grant_ledger_skip() RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT current_setting('app.platform_force_remove_org', true) IS NOT DISTINCT FROM 'on' $$;

CREATE FUNCTION authz_grant_ledger_users() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    old_roles TEXT[] := CASE WHEN TG_OP = 'INSERT' THEN '{}'::text[] ELSE OLD.roles END;
BEGIN
    IF authz_grant_ledger_skip() THEN RETURN NULL; END IF;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, actor_id, source)
        VALUES (NEW.org_id, NEW.id, 'ACCOUNT', 'account', 'GRANTED', authz_grant_ledger_actor(), 'TRIGGER');
    END IF;
    INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, actor_id, source)
    SELECT NEW.org_id, NEW.id, 'SYSTEM_ROLE', r, 'GRANTED', authz_grant_ledger_actor(), 'TRIGGER'
    FROM unnest(NEW.roles) r WHERE NOT r = ANY (old_roles)
    UNION ALL
    SELECT NEW.org_id, NEW.id, 'SYSTEM_ROLE', r, 'REVOKED', authz_grant_ledger_actor(), 'TRIGGER'
    FROM unnest(old_roles) r WHERE NOT r = ANY (NEW.roles);
    RETURN NULL;
END $$;

CREATE FUNCTION authz_grant_ledger_assignments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF authz_grant_ledger_skip() THEN RETURN NULL; END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, actor_id, source)
        VALUES (OLD.org_id, OLD.user_id, 'POLICY_ROLE', OLD.role_id::text, 'REVOKED',
                authz_grant_ledger_actor(), 'TRIGGER');
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, actor_id, source)
        VALUES (NEW.org_id, NEW.user_id, 'POLICY_ROLE', NEW.role_id::text, 'GRANTED',
                COALESCE(authz_grant_ledger_actor(), NEW.assigned_by), 'TRIGGER');
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_authz_grant_ledger_users_ins AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION authz_grant_ledger_users();
CREATE TRIGGER trg_authz_grant_ledger_users_roles AFTER UPDATE OF roles ON users
    FOR EACH ROW WHEN (OLD.roles IS DISTINCT FROM NEW.roles)
    EXECUTE FUNCTION authz_grant_ledger_users();
CREATE TRIGGER trg_authz_grant_ledger_ura AFTER INSERT OR DELETE ON user_role_assignments
    FOR EACH ROW EXECUTE FUNCTION authz_grant_ledger_assignments();
CREATE TRIGGER trg_authz_grant_ledger_ura_upd AFTER UPDATE OF user_id, role_id ON user_role_assignments
    FOR EACH ROW WHEN ((OLD.user_id, OLD.role_id) IS DISTINCT FROM (NEW.user_id, NEW.role_id))
    EXECUTE FUNCTION authz_grant_ledger_assignments();

REVOKE ALL ON FUNCTION authz_grant_ledger_users(), authz_grant_ledger_assignments() FROM PUBLIC;

COMMENT ON TABLE authz_grant_ledger IS 'BW-29 append-only history of account creation and role grants/removals; feeds the D0.2 eligible-second-person fact';
COMMENT ON COLUMN authz_grant_ledger.id IS 'pd:none — ledger row id';
COMMENT ON COLUMN authz_grant_ledger.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN authz_grant_ledger.user_id IS 'pd:personal — account the grant or removal applies to';
COMMENT ON COLUMN authz_grant_ledger.grant_kind IS 'pd:none — ACCOUNT, SYSTEM_ROLE or POLICY_ROLE';
COMMENT ON COLUMN authz_grant_ledger.grant_ref IS 'pd:none — system role key or policy role id';
COMMENT ON COLUMN authz_grant_ledger.event IS 'pd:none — GRANTED, REVOKED or NOTICE_DELIVERED (security-contact notice)';
COMMENT ON COLUMN authz_grant_ledger.actor_id IS 'pd:personal — user who made the change (app.current_actor); NULL when unknown';
COMMENT ON COLUMN authz_grant_ledger.source IS 'pd:none — TRIGGER, BACKFILL or NOTIFIER';
COMMENT ON COLUMN authz_grant_ledger.occurred_at IS 'pd:none — change time';

-- ---------------------------------------------------------------------------
-- 3. second_person_candidates: every row the D0.2 fact looks at, with a reason.
--    counted = reason IS NULL, or the demotion guard (DEMOTED_BY_REQUESTER).
--    Rust: other_eligible_holders = COUNT(DISTINCT user_id) WHERE counted AND
--    (scope_final OR the existing custom-role resolver grants p_feature_key for
--    the act's scope). Review flag = rows with reason REMOVED_*/ROLE_EDITED_*/
--    DEMOTED_*. Call it in the decision transaction, after locking the subject.
--    p_allow_roles   = system roles with permission_for(role, feature) == Allow.
--    p_all_scope_roles = roles that give BranchScope::All (identity adapter).
--    p_branch_id NULL = an org-wide act: only all-scope holders qualify.
--    p_excluded      = drafter, contributors, deciders of other steps.
--    Pending grants (BW-14) are not in users.roles or user_role_assignments
--    until they activate, so they are never candidates.
CREATE FUNCTION second_person_candidates(
    p_org UUID, p_feature_key TEXT, p_allow_roles TEXT[], p_all_scope_roles TEXT[],
    p_branch_id UUID, p_requester UUID, p_excluded UUID[],
    p_case_created_at TIMESTAMPTZ, p_min_grant_age INTERVAL, p_demotion_lookback INTERVAL)
RETURNS TABLE (user_id UUID, via TEXT, grant_ref TEXT, counted BOOLEAN, reason TEXT, scope_final BOOLEAN)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
WITH win AS (
    SELECT now() - p_min_grant_age AS age_cutoff,
           p_case_created_at - p_demotion_lookback AS demotion_from,
           LEAST(now() - p_min_grant_age, p_case_created_at - p_demotion_lookback) AS requester_from
),
held_sys AS (
    SELECT u.id AS user_id, 'SYSTEM_ROLE'::text AS via, r AS grant_ref,
           NULL::timestamptz AS def_at, NULL::uuid AS def_by, true AS scope_final
    FROM users u CROSS JOIN LATERAL unnest(u.roles) r
    WHERE u.org_id = p_org AND r = ANY (p_allow_roles)
      AND (u.roles && p_all_scope_roles
           OR (p_branch_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM user_branches ub
                WHERE ub.org_id = p_org AND ub.user_id = u.id AND ub.branch_id = p_branch_id)))
),
held_pol AS (
    SELECT a.user_id, 'POLICY_ROLE'::text, pr.id::text,
           GREATEST(prp.created_at, pr.updated_at), pr.updated_by, false
    FROM user_role_assignments a
    JOIN policy_roles pr ON pr.org_id = a.org_id AND pr.id = a.role_id
                        AND pr.status = 'ACTIVE' AND NOT pr.is_system
    JOIN policy_role_permissions prp ON prp.org_id = pr.org_id AND prp.role_id = pr.id
                        AND prp.feature_key = p_feature_key AND prp.permission_level = 'allow'
    WHERE a.org_id = p_org
    FOR SHARE OF a
),
held AS (SELECT * FROM held_sys UNION ALL SELECT * FROM held_pol),
-- Conflicts with the account mutex (0227/0233 FOR [NO KEY] UPDATE), so a
-- concurrent demotion of a candidate serializes behind this decision.
locked AS (
    SELECT u.id, u.is_active, u.employee_id FROM users u
    WHERE u.org_id = p_org AND u.id IN (SELECT h.user_id FROM held h)
    FOR SHARE OF u
),
meta AS (
    SELECT h.*, l.is_active, l.employee_id, g.occurred_at AS granted_at, g.actor_id AS granted_by,
           acct.occurred_at AS account_at, acct.actor_id AS account_by,
           EXISTS (SELECT 1 FROM authz_grant_ledger n
                   WHERE n.org_id = p_org AND n.user_id = h.user_id AND n.grant_kind = h.via
                     AND n.grant_ref = h.grant_ref AND n.event = 'NOTICE_DELIVERED'
                     AND n.occurred_at >= g.occurred_at) AS notified
    FROM held h JOIN locked l ON l.id = h.user_id
    LEFT JOIN LATERAL (
        SELECT x.occurred_at, x.actor_id FROM authz_grant_ledger x
        WHERE x.org_id = p_org AND x.user_id = h.user_id AND x.grant_kind = h.via
          AND x.grant_ref = h.grant_ref AND x.event = 'GRANTED'
        ORDER BY x.occurred_at DESC LIMIT 1) g ON true
    LEFT JOIN LATERAL (
        SELECT x.occurred_at, x.actor_id FROM authz_grant_ledger x
        WHERE x.org_id = p_org AND x.user_id = h.user_id AND x.grant_kind = 'ACCOUNT'
        ORDER BY x.occurred_at DESC LIMIT 1) acct ON true
),
holders AS (
    SELECT m.user_id, m.via, m.grant_ref, m.scope_final, CASE
        WHEN m.user_id = p_requester OR m.user_id = ANY (COALESCE(p_excluded, '{}')) THEN 'EXCLUDED_PARTY'
        WHEN NOT m.is_active THEN 'INACTIVE'
        WHEN m.employee_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM governed_exceptions ge
            WHERE ge.org_id = p_org AND ge.rule_code = 'NON_EMPLOYEE_ACCOUNT'
              AND ge.subject_type = 'USER_ACCOUNT' AND ge.subject_id = m.user_id
              AND ge.status IN ('APPROVED', 'RECORDED')) THEN 'NO_EMPLOYEE_LINK'
        WHEN m.account_by = p_requester AND m.account_at >= w.requester_from
            THEN 'ACCOUNT_CREATED_BY_REQUESTER'
        WHEN (m.granted_by = p_requester AND m.granted_at >= w.requester_from)
          OR (m.def_by = p_requester AND m.def_at >= w.requester_from) THEN 'GRANTED_BY_REQUESTER'
        WHEN m.granted_at IS NULL OR m.granted_at > w.age_cutoff OR m.def_at > w.age_cutoff
            THEN 'GRANT_TOO_YOUNG'
        WHEN NOT m.notified THEN 'NOTICE_UNDELIVERED'
    END AS reason
    FROM meta m CROSS JOIN win w
),
-- Demotion guard: qualifying removals since case creation - lookback.
removed AS (
    SELECT x.user_id, x.grant_kind AS via, x.grant_ref, CASE
        WHEN x.user_id = p_requester OR x.user_id = ANY (COALESCE(p_excluded, '{}')) THEN 'EXCLUDED_PARTY'
        WHEN x.actor_id = p_requester AND COALESCE(u.is_active, false) THEN 'DEMOTED_BY_REQUESTER'
        WHEN x.actor_id = p_requester THEN 'REMOVED_THEN_INACTIVE'
        WHEN x.actor_id IS NULL THEN 'REMOVED_BY_UNKNOWN'
        ELSE 'REMOVED_BY_OTHER'
    END AS reason
    FROM authz_grant_ledger x CROSS JOIN win w
    LEFT JOIN users u ON u.org_id = p_org AND u.id = x.user_id
    WHERE x.org_id = p_org AND x.event = 'REVOKED' AND x.occurred_at >= w.demotion_from
      AND ((x.grant_kind = 'SYSTEM_ROLE' AND x.grant_ref = ANY (p_allow_roles))
        OR (x.grant_kind = 'POLICY_ROLE' AND EXISTS (
            SELECT 1 FROM policy_role_permissions prp
            WHERE prp.org_id = p_org AND prp.role_id::text = x.grant_ref
              AND prp.feature_key = p_feature_key AND prp.permission_level = 'allow')))
),
-- ponytail: role-definition edits (retire a role, drop its permission) are
-- not in the ledger, so they are review-flagged, not counted. Add role-level
-- ledger rows if the review queue shows this path being used.
edited AS (
    SELECT NULL::uuid AS user_id, 'POLICY_ROLE'::text AS via, pr.id::text AS grant_ref,
           'ROLE_EDITED_BY_REQUESTER'::text AS reason
    FROM policy_roles pr CROSS JOIN win w
    WHERE pr.org_id = p_org AND pr.updated_by = p_requester AND pr.updated_at >= w.demotion_from
)
SELECT user_id, via, grant_ref, reason IS NULL, reason, scope_final FROM holders
UNION ALL
SELECT user_id, via, grant_ref, reason = 'DEMOTED_BY_REQUESTER', reason, true FROM removed
UNION ALL
SELECT user_id, via, grant_ref, false, reason, true FROM edited
$$;
REVOKE ALL ON FUNCTION second_person_candidates(UUID, TEXT, TEXT[], TEXT[], UUID, UUID, UUID[],
    TIMESTAMPTZ, INTERVAL, INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION second_person_candidates(UUID, TEXT, TEXT[], TEXT[], UUID, UUID, UUID[],
    TIMESTAMPTZ, INTERVAL, INTERVAL) TO console_rt;
