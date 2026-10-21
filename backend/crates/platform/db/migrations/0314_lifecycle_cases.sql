-- LC-B3: the case core (lifecycle-events.md §2, §5.1-§5.6). Every lifecycle
-- event opens a case; a case is one dossier of typed items, each with its
-- basis, due rule, owner line and status. No REST yet (LC-B4); no openers yet
-- (LC-B6). Numbered after 0306; INTEG renumbers.
--
--   1. case_templates / case_template_items: GLOBAL, migration-only, HOLD,
--      versioned, effective-dated (the 0253 model). Only the EXIT template
--      ships here (LC-B5 adds the rest).
--   2. tenant_case_template_items: a tenant ADDS items (its own T-keys); it can
--      never shadow, remove or loosen a statutory row.
--   3. lifecycle_cases / lifecycle_case_items with typed statuses and their
--      DB backstops (self-completion, write-once results, no guessed deadline,
--      no close over an open blocking item).
--   4. lifecycle_case_clock_runs: the worker's once-per-tenant-per-day claim.
--   5. statutory_rules: two due numbers the EXIT rows need (HOLD).
--   6. governed_exceptions.subject_type admits LIFECYCLE_CASE_ITEM.
--   7. Event-stream vocabulary (#27), when realtime_topic_map exists.
--   8. The exit-case backfill (§5.1: CANCELLED / PRE_CONSOLE / live).
--
-- employee_exit_cases does NOT get its FK to lifecycle_cases here: the exit
-- report (exits/report.rs) inserts exit cases with no case row until LC-B6's
-- opener, and an enforced FK would break reporting. Instead a case opened BY
-- an exit case references it (exit_case_id below), which keeps "same id".
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Templates (global reference data).
CREATE TABLE case_templates (
    template_key           TEXT    NOT NULL CHECK (template_key ~ '^[A-Z][A-Z_]{1,39}$'),
    version                INT     NOT NULL CHECK (version >= 1),
    kind                   TEXT    NOT NULL CHECK (kind IN (
                               'HIRE', 'PROBATION_END', 'APPOINT', 'LEAVE_START', 'LEAVE_RETURN',
                               'CONTRACT', 'EXIT', 'ENTITY', 'WORKPLACE', 'ADMIN_HANDOVER')),
    effective_from         DATE    NOT NULL,
    effective_to_exclusive DATE    NULL CHECK (effective_to_exclusive IS NULL OR effective_to_exclusive > effective_from),
    release_disposition    TEXT    NOT NULL DEFAULT 'HOLD' CHECK (release_disposition IN ('HOLD', 'RELEASED')),
    review_receipt_ref     TEXT    NULL CHECK (review_receipt_ref IS NULL OR btrim(review_receipt_ref) <> ''),
    change_note            TEXT    NOT NULL CHECK (btrim(change_note) <> ''),
    CONSTRAINT case_templates_receipt_iff_released
        CHECK ((release_disposition = 'RELEASED') = (review_receipt_ref IS NOT NULL)),
    PRIMARY KEY (template_key, version)
);

-- The closed vocabularies, shared by template rows, tenant rows and items.
--   owner_line: access-model permission line <domain>.<level> (0301 domains).
--   applicability: every element must hold (! = must not hold), §5.4.
--   due rule: anchor + kind + register code (§5.3). The kinds that carry a
--   number name a statutory code or an SF ins.deadline.* key (SF §3.1; the
--   bw30 codes are its lose.* rows, aliased in the register); the others carry
--   none. UNKNOWN is 「기한 미확인」 and never a date.
CREATE TABLE case_template_items (
    template_key      TEXT    NOT NULL,
    version           INT     NOT NULL,
    item_key          TEXT    NOT NULL CHECK (item_key ~ '^[A-Z][A-Za-z]{0,3}[0-9]{1,2}$'),
    ord               INT     NOT NULL CHECK (ord >= 1),
    -- NULL: every variant of the template's kind.
    variants          TEXT[]  NULL CHECK (variants IS NULL OR cardinality(variants) >= 1),
    label_ko          TEXT    NOT NULL CHECK (char_length(btrim(label_ko)) BETWEEN 1 AND 200),
    kind              TEXT    NOT NULL CHECK (kind IN ('DOC', 'FIL', 'NOT', 'PAY', 'BACK', 'ACC', 'REC')),
    venue             TEXT    NOT NULL CHECK (venue IN ('IN_CONSOLE', 'OUTSIDE')),
    mode              TEXT    NOT NULL CHECK (mode IN ('OBSERVED', 'ATTESTED', 'REQUESTED')),
    -- NULL only for server-observed items nobody completes (X17, DM5).
    owner_line        TEXT    NULL CHECK (owner_line ~ '^(org|hr_basic|appointment|exit|attendance|pay|access|settings)\.(edit|approve)$'),
    applicability     TEXT[]  NOT NULL DEFAULT '{}',
    due_anchor        TEXT    NULL CHECK (due_anchor IN (
                          'EFFECTIVE_DATE', 'EXIT_DATE', 'LOSS_DATE', 'START_DATE', 'REQUEST_DATE',
                          'REGISTRATION_DATE', 'PAYMENT_DATE', 'TWO_YEAR_DATE', 'EXPECTED_RETURN')),
    due_rule_kind     TEXT    NOT NULL CHECK (due_rule_kind IN (
                          'DAYS_AFTER', 'DAY_OF_NEXT_MONTH', 'MONTHS_AFTER', 'DAYS_BEFORE',
                          'END_OF_NEXT_MONTH', 'IMMEDIATE', 'WITHOUT_DELAY', 'UNKNOWN')),
    due_register_code TEXT    NULL CHECK (due_register_code ~ '^([A-Z][A-Z0-9_]{2,63}|ins\.deadline\.(acquire|lose|leave|resume|change)\.(nps|nhis|ei|iaci))$'),
    blocks_close      BOOLEAN NOT NULL,
    legal             BOOLEAN NOT NULL,
    instrument_ko     TEXT    NULL CHECK (instrument_ko IS NULL OR btrim(instrument_ko) <> ''),
    article_ko        TEXT    NULL CHECK (article_ko IS NULL OR btrim(article_ko) <> ''),
    -- The design's evidence tag for the row: V-API / V-REPO / J / U.
    basis_tag         TEXT    NOT NULL CHECK (basis_tag IN ('V-API', 'V-REPO', 'J', 'U')),
    PRIMARY KEY (template_key, version, item_key),
    FOREIGN KEY (template_key, version) REFERENCES case_templates (template_key, version) ON DELETE RESTRICT,
    CONSTRAINT case_template_items_applicability_closed CHECK (
        array_to_string(applicability, ',') ~ '^(!?(HEADCOUNT_5_PLUS|HEADCOUNT_10_PLUS|HEADCOUNT_100_PLUS_NHIS|SERVICE_GE_3_MONTHS|SERVICE_GE_30_DAYS|SEVERANCE_ELIGIBLE|MINOR|DAILY_UNDER_30_DAYS|SUBJECT_DECEASED|EMPLOYED_ELSEWHERE_IN_TENANT|TERMS_CHANGE_BY_RULES|INSURER_APPLIES_EI|INSURER_APPLIES_NPS|INSURER_APPLIES_NHIS|INSURER_APPLIES_IACI|OWN_INSURANCE_UNIT|HAS_DC_PLAN|PAY_CHANGES|TERMS_CHANGE|REGISTERED_BRANCH|NEW_INCORPORATION|FIRST_HIRE_RECORDED|CONTINUITY_SETTLED|CONTINUITY_CARRIED)(,|$))*$'),
    CONSTRAINT case_template_items_due_shape CHECK (CASE
        WHEN due_rule_kind = 'UNKNOWN' THEN due_anchor IS NULL AND due_register_code IS NULL
        WHEN due_rule_kind IN ('DAYS_AFTER', 'DAY_OF_NEXT_MONTH', 'MONTHS_AFTER', 'DAYS_BEFORE')
            THEN due_anchor IS NOT NULL AND due_register_code IS NOT NULL
        ELSE due_anchor IS NOT NULL AND due_register_code IS NULL END),
    CONSTRAINT case_template_items_requested_anchor CHECK ((mode = 'REQUESTED') = (due_anchor IS NOT DISTINCT FROM 'REQUEST_DATE')),
    CONSTRAINT case_template_items_owner CHECK (owner_line IS NOT NULL OR mode = 'OBSERVED'),
    CONSTRAINT case_template_items_legal_cited CHECK (NOT legal OR (instrument_ko IS NOT NULL AND article_ko IS NOT NULL)),
    UNIQUE (template_key, version, ord)
);

REVOKE ALL ON case_templates, case_template_items FROM PUBLIC;
REVOKE ALL ON case_templates, case_template_items FROM console_rt;
GRANT SELECT ON case_templates, case_template_items TO console_rt;

COMMENT ON TABLE case_templates IS '생애 사건 처리 항목 템플릿(전역·마이그레이션 전용·HOLD). 노무사 검토 영수증 전까지 HOLD이며 법적 결론을 주장하지 않는다.';
COMMENT ON COLUMN case_templates.template_key IS 'pd:none — template key vocabulary';
COMMENT ON COLUMN case_templates.version IS 'pd:none — template version';
COMMENT ON COLUMN case_templates.kind IS 'pd:none — lifecycle event kind vocabulary';
COMMENT ON COLUMN case_templates.effective_from IS 'pd:none — first day the version applies (law slice)';
COMMENT ON COLUMN case_templates.effective_to_exclusive IS 'pd:none — day the version stops applying';
COMMENT ON COLUMN case_templates.release_disposition IS 'pd:none — HOLD until a qualified reviewer releases it';
COMMENT ON COLUMN case_templates.review_receipt_ref IS 'pd:none — reviewer receipt in the jurisdiction register';
COMMENT ON COLUMN case_templates.change_note IS 'pd:none — why this version exists';
COMMENT ON COLUMN case_template_items.template_key IS 'pd:none — template key vocabulary';
COMMENT ON COLUMN case_template_items.version IS 'pd:none — template version';
COMMENT ON COLUMN case_template_items.item_key IS 'pd:none — item key (design row id)';
COMMENT ON COLUMN case_template_items.ord IS 'pd:none — display order';
COMMENT ON COLUMN case_template_items.variants IS 'pd:none — variants the row applies to';
COMMENT ON COLUMN case_template_items.label_ko IS 'pd:none — item label';
COMMENT ON COLUMN case_template_items.kind IS 'pd:none — item kind vocabulary';
COMMENT ON COLUMN case_template_items.venue IS 'pd:none — in the console or outside';
COMMENT ON COLUMN case_template_items.mode IS 'pd:none — how the item is done';
COMMENT ON COLUMN case_template_items.owner_line IS 'pd:none — permission line that may complete it';
COMMENT ON COLUMN case_template_items.applicability IS 'pd:none — derived facts that must hold';
COMMENT ON COLUMN case_template_items.due_anchor IS 'pd:none — date the due rule counts from';
COMMENT ON COLUMN case_template_items.due_rule_kind IS 'pd:none — due rule kind vocabulary';
COMMENT ON COLUMN case_template_items.due_register_code IS 'pd:none — statutory register code or SF ins.deadline key';
COMMENT ON COLUMN case_template_items.blocks_close IS 'pd:none — whether an open item blocks the case close';
COMMENT ON COLUMN case_template_items.legal IS 'pd:none — whether the row is a cited statutory duty';
COMMENT ON COLUMN case_template_items.instrument_ko IS 'pd:none — cited instrument';
COMMENT ON COLUMN case_template_items.article_ko IS 'pd:none — cited article';
COMMENT ON COLUMN case_template_items.basis_tag IS 'pd:none — evidence tag of the design row';

-- ---------------------------------------------------------------------------
-- 2. Tenant additions: append-only, own key namespace (T1, T2, ...), closing
-- sets effective_to. The settings path (step-up, effective-dated) is LC-B4's.
CREATE TABLE tenant_case_template_items (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    template_key    TEXT        NOT NULL CHECK (template_key ~ '^[A-Z][A-Z_]{1,39}$'),
    item_key        TEXT        NOT NULL CHECK (item_key ~ '^T[0-9]{1,3}$'),
    label_ko        TEXT        NOT NULL CHECK (char_length(btrim(label_ko)) BETWEEN 1 AND 200),
    kind            TEXT        NOT NULL CHECK (kind IN ('DOC', 'FIL', 'NOT', 'PAY', 'BACK', 'ACC', 'REC')),
    venue           TEXT        NOT NULL CHECK (venue IN ('IN_CONSOLE', 'OUTSIDE')),
    mode            TEXT        NOT NULL CHECK (mode IN ('ATTESTED', 'REQUESTED')),
    owner_line      TEXT        NOT NULL CHECK (owner_line ~ '^(org|hr_basic|appointment|exit|attendance|pay|access|settings)\.(edit|approve)$'),
    due_anchor      TEXT        NULL CHECK (due_anchor IN ('EFFECTIVE_DATE', 'EXIT_DATE', 'START_DATE', 'REQUEST_DATE')),
    due_offset_days INT         NULL CHECK (due_offset_days BETWEEN -365 AND 365),
    blocks_close    BOOLEAN     NOT NULL,
    effective_from  DATE        NOT NULL,
    effective_to    DATE        NULL CHECK (effective_to IS NULL OR effective_to > effective_from),
    created_by      UUID        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason_code     TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, template_key, item_key, effective_from),
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT tenant_case_template_items_due_shape CHECK ((due_anchor IS NULL) = (due_offset_days IS NULL))
);
CREATE FUNCTION tenant_case_template_items_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('app.platform_force_remove_org', true) = 'on' THEN
            RETURN OLD;
        END IF;
    ELSIF OLD.effective_to IS NULL AND (to_jsonb(NEW) - 'effective_to') = (to_jsonb(OLD) - 'effective_to') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'template_item_statutory: tenant template items are append-only; close one by setting effective_to once (%)', TG_OP
        USING ERRCODE = '55000';
END $$;
CREATE TRIGGER trg_tenant_case_template_items_append_only
    BEFORE UPDATE OR DELETE ON tenant_case_template_items
    FOR EACH ROW EXECUTE FUNCTION tenant_case_template_items_append_only();

ALTER TABLE tenant_case_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_case_template_items FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_case_template_items
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON tenant_case_template_items FROM PUBLIC;
REVOKE ALL ON tenant_case_template_items FROM console_rt;
GRANT SELECT, INSERT, UPDATE ON tenant_case_template_items TO console_rt;

COMMENT ON COLUMN tenant_case_template_items.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN tenant_case_template_items.id IS 'pd:none — row id';
COMMENT ON COLUMN tenant_case_template_items.template_key IS 'pd:none — template key vocabulary';
COMMENT ON COLUMN tenant_case_template_items.item_key IS 'pd:none — tenant item key (T-namespace)';
COMMENT ON COLUMN tenant_case_template_items.label_ko IS 'pd:none — tenant item label';
COMMENT ON COLUMN tenant_case_template_items.kind IS 'pd:none — item kind vocabulary';
COMMENT ON COLUMN tenant_case_template_items.venue IS 'pd:none — in the console or outside';
COMMENT ON COLUMN tenant_case_template_items.mode IS 'pd:none — how the item is done';
COMMENT ON COLUMN tenant_case_template_items.owner_line IS 'pd:none — permission line that may complete it';
COMMENT ON COLUMN tenant_case_template_items.due_anchor IS 'pd:none — date the offset counts from';
COMMENT ON COLUMN tenant_case_template_items.due_offset_days IS 'pd:none — tenant policy offset in days';
COMMENT ON COLUMN tenant_case_template_items.blocks_close IS 'pd:none — whether an open item blocks the case close';
COMMENT ON COLUMN tenant_case_template_items.effective_from IS 'pd:none — first day the addition applies';
COMMENT ON COLUMN tenant_case_template_items.effective_to IS 'pd:none — day the addition stops applying';
COMMENT ON COLUMN tenant_case_template_items.created_by IS 'pd:personal — 처리자 식별자 - users.id';
COMMENT ON COLUMN tenant_case_template_items.created_at IS 'pd:none — creation time';
COMMENT ON COLUMN tenant_case_template_items.reason_code IS 'pd:none — reason code';

-- ---------------------------------------------------------------------------
-- 3. Cases and items.
CREATE TABLE lifecycle_cases (
    org_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                UUID        NOT NULL DEFAULT gen_random_uuid(),
    kind              TEXT        NOT NULL CHECK (kind IN (
                          'HIRE', 'PROBATION_END', 'APPOINT', 'LEAVE_START', 'LEAVE_RETURN',
                          'CONTRACT', 'EXIT', 'ENTITY', 'WORKPLACE', 'ADMIN_HANDOVER')),
    -- NULL: the variant is not known (an exit reported with no mapped reason).
    variant           TEXT        NULL CHECK (variant ~ '^[A-Z][A-Z_]{1,39}$'),
    subject_kind      TEXT        NOT NULL CHECK (subject_kind IN ('EMPLOYMENT', 'LEGAL_ENTITY', 'WORKPLACE', 'TENANT')),
    employee_id       UUID        NULL,
    employment_id     UUID        NULL,
    legal_entity_id   UUID        NULL,
    workplace_id      UUID        NULL,
    branch_id         UUID        NULL,
    trigger_kind      TEXT        NOT NULL CHECK (trigger_kind IN (
                          'LIFECYCLE_EVENT', 'EXIT_CASE', 'ENTITY_REVISION', 'WORKPLACE_REVISION', 'HANDOVER', 'SCHEDULE')),
    trigger_id        UUID        NULL,
    effective_date    DATE        NOT NULL,
    template_key      TEXT        NOT NULL,
    template_version  INT         NOT NULL,
    state             TEXT        NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'CLOSED', 'CANCELLED')),
    closed_at         TIMESTAMPTZ NULL,
    close_basis       TEXT        NULL CHECK (close_basis IN ('ALL_TERMINAL', 'WAIVED_REMAINDER')),
    linked_case_id    UUID        NULL,
    opened_by         UUID        NULL,
    opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           BIGINT      NOT NULL DEFAULT 1 CHECK (version >= 1),
    settings_snapshot JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings_snapshot) = 'object'),
    -- An EXIT case opened by an exit case IS that exit case (same id).
    exit_case_id      UUID        GENERATED ALWAYS AS (CASE WHEN trigger_kind = 'EXIT_CASE' THEN id END) STORED,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (template_key, template_version) REFERENCES case_templates (template_key, version) ON DELETE RESTRICT,
    FOREIGN KEY (exit_case_id, org_id) REFERENCES employee_exit_cases (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, employment_id) REFERENCES employment_heads (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, linked_case_id) REFERENCES lifecycle_cases (org_id, id) ON DELETE SET NULL (linked_case_id),
    FOREIGN KEY (opened_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT lifecycle_cases_exit_trigger CHECK (trigger_kind <> 'EXIT_CASE' OR (kind = 'EXIT' AND trigger_id = id)),
    -- employment_id stays nullable until LC-B2 writes it for every new case.
    CONSTRAINT lifecycle_cases_subject_shape CHECK (CASE subject_kind
        WHEN 'EMPLOYMENT' THEN employee_id IS NOT NULL
        WHEN 'LEGAL_ENTITY' THEN legal_entity_id IS NOT NULL AND employee_id IS NULL
        WHEN 'WORKPLACE' THEN workplace_id IS NOT NULL AND employee_id IS NULL
        ELSE employee_id IS NULL AND legal_entity_id IS NULL AND workplace_id IS NULL END),
    CONSTRAINT lifecycle_cases_state_shape CHECK (
        (state = 'OPEN') = (closed_at IS NULL) AND (state = 'CLOSED') = (close_basis IS NOT NULL)),
    CONSTRAINT lifecycle_cases_not_self_linked CHECK (linked_case_id <> id)
);
CREATE INDEX lifecycle_cases_state_idx ON lifecycle_cases (org_id, state, kind, effective_date);
CREATE INDEX lifecycle_cases_employee_idx ON lifecycle_cases (org_id, employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE lifecycle_case_items (
    org_id                UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
    case_id               UUID        NOT NULL,
    item_key              TEXT        NOT NULL CHECK (item_key ~ '^([A-Z][A-Za-z]{0,3}[0-9]{1,2}|AH[0-9]{1,3})$'),
    source                TEXT        NOT NULL CHECK (source IN ('TEMPLATE', 'TENANT', 'AD_HOC')),
    template_item_version INT         NULL,
    label_ko              TEXT        NULL CHECK (label_ko IS NULL OR char_length(btrim(label_ko)) BETWEEN 1 AND 200),
    kind                  TEXT        NOT NULL CHECK (kind IN ('DOC', 'FIL', 'NOT', 'PAY', 'BACK', 'ACC', 'REC')),
    venue                 TEXT        NOT NULL CHECK (venue IN ('IN_CONSOLE', 'OUTSIDE')),
    mode                  TEXT        NOT NULL CHECK (mode IN ('OBSERVED', 'ATTESTED', 'REQUESTED')),
    owner_line            TEXT        NULL CHECK (owner_line ~ '^(org|hr_basic|appointment|exit|attendance|pay|access|settings)\.(edit|approve)$'),
    assignee_user_id      UUID        NULL,
    requested_on          DATE        NULL,
    due_date              DATE        NULL,
    due_rule_ref          TEXT        NULL,
    -- '{}' = not computed yet (the worker tick computes it through case_clocks).
    due_basis             JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(due_basis) = 'object'),
    due_disposition       TEXT        NOT NULL CHECK (due_disposition IN ('RELEASED', 'HOLD', 'UNKNOWN')),
    status                TEXT        NOT NULL CHECK (status IN (
                              'PENDING_TRIGGER', 'OPEN', 'BLOCKED', 'DONE_OBSERVED', 'DONE_ATTESTED',
                              'NOT_APPLICABLE', 'WAIVED', 'CANCELLED', 'CORRECTION_NEEDED')),
    status_code           TEXT        NULL CHECK (status_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    blocks_close          BOOLEAN     NOT NULL,
    legal                 BOOLEAN     NOT NULL,
    observed_ref          JSONB       NULL CHECK (observed_ref IS NULL OR (jsonb_typeof(observed_ref) = 'object' AND observed_ref ? 'table')),
    exception_id          UUID        NULL,
    filing_obligation_id  UUID        NULL,
    done_at               TIMESTAMPTZ NULL,
    done_by               UUID        NULL,
    version               BIGINT      NOT NULL DEFAULT 1 CHECK (version >= 1),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, case_id, item_key),
    FOREIGN KEY (org_id, case_id) REFERENCES lifecycle_cases (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (assignee_user_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (done_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (exception_id, org_id) REFERENCES governed_exceptions (id, org_id) ON DELETE RESTRICT,
    -- 「기한 미확인」 is never a date (§5.3, §9.3).
    CONSTRAINT lifecycle_case_items_no_guessed_deadline CHECK (due_disposition <> 'UNKNOWN' OR due_date IS NULL),
    CONSTRAINT lifecycle_case_items_requested_mode CHECK (requested_on IS NULL OR mode = 'REQUESTED'),
    CONSTRAINT lifecycle_case_items_source_shape CHECK (
        (source = 'TEMPLATE') = (template_item_version IS NOT NULL) AND (source = 'TEMPLATE' OR label_ko IS NOT NULL)),
    -- Typed statuses (§5.2): each result names what closed it.
    CONSTRAINT lifecycle_case_items_status_shape CHECK (CASE status
        WHEN 'PENDING_TRIGGER' THEN status_code IS NULL AND done_at IS NULL AND requested_on IS NULL
        WHEN 'OPEN' THEN status_code IS NULL AND done_at IS NULL
        WHEN 'BLOCKED' THEN status_code IS NOT NULL AND done_at IS NULL
        WHEN 'DONE_OBSERVED' THEN observed_ref IS NOT NULL AND done_at IS NOT NULL
        WHEN 'DONE_ATTESTED' THEN exception_id IS NOT NULL AND done_by IS NOT NULL AND done_at IS NOT NULL
        WHEN 'WAIVED' THEN exception_id IS NOT NULL AND done_by IS NOT NULL AND done_at IS NOT NULL
        WHEN 'NOT_APPLICABLE' THEN status_code IS NOT NULL AND done_at IS NOT NULL
        WHEN 'CANCELLED' THEN status_code IS NOT NULL AND done_at IS NOT NULL
        ELSE done_at IS NOT NULL END)
);
CREATE INDEX lifecycle_case_items_due_idx ON lifecycle_case_items (org_id, due_date)
    WHERE status IN ('PENDING_TRIGGER', 'OPEN', 'BLOCKED');
CREATE INDEX lifecycle_case_items_assignee_idx ON lifecycle_case_items (org_id, assignee_user_id)
    WHERE assignee_user_id IS NOT NULL;

-- Nobody completes or waives an item of their own case (§5.5, §6.1
-- self_completion): the DB backstop under the Cedar forbid.
-- A result is write-once (attestation_immutable): a terminal item changes only
-- from DONE_* to CORRECTION_NEEDED, keeping what was recorded.
CREATE FUNCTION lifecycle_case_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IN ('DONE_OBSERVED', 'DONE_ATTESTED', 'NOT_APPLICABLE', 'WAIVED',
                                           'CANCELLED', 'CORRECTION_NEEDED')
       AND (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version') THEN
        IF NOT (OLD.status IN ('DONE_OBSERVED', 'DONE_ATTESTED') AND NEW.status = 'CORRECTION_NEEDED'
                AND (to_jsonb(NEW) - ARRAY['status', 'status_code', 'version'])
                    = (to_jsonb(OLD) - ARRAY['status', 'status_code', 'version'])) THEN
            RAISE EXCEPTION 'attestation_immutable: item % is % and cannot change', OLD.id, OLD.status
                USING ERRCODE = '55000';
        END IF;
    END IF;
    IF NEW.done_by IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.done_by IS DISTINCT FROM OLD.done_by) AND EXISTS (
        SELECT 1 FROM lifecycle_cases c JOIN users u ON u.org_id = c.org_id AND u.id = NEW.done_by
        WHERE c.org_id = NEW.org_id AND c.id = NEW.case_id AND c.employee_id IS NOT NULL
          AND u.employee_id = c.employee_id
    ) THEN
        RAISE EXCEPTION 'self_completion: user % cannot complete an item of their own case', NEW.done_by
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_lifecycle_case_items_guard
    BEFORE INSERT OR UPDATE ON lifecycle_case_items
    FOR EACH ROW EXECUTE FUNCTION lifecycle_case_items_guard();

-- case_has_open_items: a case closes only when no blocking item is open.
CREATE FUNCTION lifecycle_cases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state = 'CLOSED' AND NEW.close_basis = 'ALL_TERMINAL' AND EXISTS (
        SELECT 1 FROM lifecycle_case_items i
        WHERE i.org_id = NEW.org_id AND i.case_id = NEW.id AND i.blocks_close
          AND i.status IN ('PENDING_TRIGGER', 'OPEN', 'BLOCKED')
    ) THEN
        RAISE EXCEPTION 'case_has_open_items: case % has an open blocking item', NEW.id
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.state = 'CANCELLED' AND NEW.state <> 'CANCELLED' THEN
        RAISE EXCEPTION 'lifecycle case % was cancelled and cannot reopen', OLD.id USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_lifecycle_cases_guard
    BEFORE INSERT OR UPDATE ON lifecycle_cases
    FOR EACH ROW EXECUTE FUNCTION lifecycle_cases_guard();

CREATE TABLE lifecycle_case_clock_runs (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    run_date   DATE        NOT NULL,
    ran_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, run_date)
);

ALTER TABLE lifecycle_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON lifecycle_cases
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
ALTER TABLE lifecycle_case_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_case_items FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON lifecycle_case_items
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
ALTER TABLE lifecycle_case_clock_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_case_clock_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON lifecycle_case_clock_runs
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON lifecycle_cases, lifecycle_case_items, lifecycle_case_clock_runs FROM PUBLIC;
REVOKE ALL ON lifecycle_cases, lifecycle_case_items, lifecycle_case_clock_runs FROM console_rt;
GRANT SELECT, INSERT, UPDATE ON lifecycle_cases, lifecycle_case_items TO console_rt;
GRANT SELECT, INSERT ON lifecycle_case_clock_runs TO console_rt;

COMMENT ON COLUMN lifecycle_cases.org_id IS 'pd:personal — 특정 자연인의 사건 처리 묶음; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN lifecycle_cases.id IS 'pd:personal — 사건 처리 묶음 식별자';
COMMENT ON COLUMN lifecycle_cases.kind IS 'pd:personal — 생애 사건 종류';
COMMENT ON COLUMN lifecycle_cases.variant IS 'pd:personal — 사건 세부 유형(퇴직 사유 등)';
COMMENT ON COLUMN lifecycle_cases.subject_kind IS 'pd:personal — 대상 종류';
COMMENT ON COLUMN lifecycle_cases.employee_id IS 'pd:personal — 직원 레코드 식별자 - employees.id';
COMMENT ON COLUMN lifecycle_cases.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN lifecycle_cases.legal_entity_id IS 'pd:personal — 대상 법인';
COMMENT ON COLUMN lifecycle_cases.workplace_id IS 'pd:personal — 대상 사업장';
COMMENT ON COLUMN lifecycle_cases.branch_id IS 'pd:personal — 범위 지점';
COMMENT ON COLUMN lifecycle_cases.trigger_kind IS 'pd:personal — 사건을 연 원천 종류';
COMMENT ON COLUMN lifecycle_cases.trigger_id IS 'pd:personal — 사건을 연 원천 식별자';
COMMENT ON COLUMN lifecycle_cases.effective_date IS 'pd:personal — 사건 시행일';
COMMENT ON COLUMN lifecycle_cases.template_key IS 'pd:personal — 고정된 템플릿 키';
COMMENT ON COLUMN lifecycle_cases.template_version IS 'pd:personal — 고정된 템플릿 버전';
COMMENT ON COLUMN lifecycle_cases.state IS 'pd:personal — 사건 처리 상태';
COMMENT ON COLUMN lifecycle_cases.closed_at IS 'pd:personal — 종결 시각';
COMMENT ON COLUMN lifecycle_cases.close_basis IS 'pd:personal — 종결 근거';
COMMENT ON COLUMN lifecycle_cases.linked_case_id IS 'pd:personal — 연결 사건(전적 A↔B 등)';
COMMENT ON COLUMN lifecycle_cases.opened_by IS 'pd:personal — 처리자 식별자 - users.id';
COMMENT ON COLUMN lifecycle_cases.opened_at IS 'pd:personal — 개시 시각';
COMMENT ON COLUMN lifecycle_cases.version IS 'pd:personal — 동시성 버전';
COMMENT ON COLUMN lifecycle_cases.settings_snapshot IS 'pd:personal,undeclared — 개시 시점 설정값 스냅숏';
COMMENT ON COLUMN lifecycle_cases.exit_case_id IS 'pd:personal — 이 사건을 연 퇴직 건 - employee_exit_cases.id';
COMMENT ON COLUMN lifecycle_case_items.org_id IS 'pd:personal — 특정 자연인의 사건 처리 항목; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN lifecycle_case_items.id IS 'pd:personal — 처리 항목 식별자';
COMMENT ON COLUMN lifecycle_case_items.case_id IS 'pd:personal — 사건 처리 묶음 식별자';
COMMENT ON COLUMN lifecycle_case_items.item_key IS 'pd:personal — 항목 키';
COMMENT ON COLUMN lifecycle_case_items.source IS 'pd:personal — 항목 출처';
COMMENT ON COLUMN lifecycle_case_items.template_item_version IS 'pd:personal — 템플릿 버전';
COMMENT ON COLUMN lifecycle_case_items.label_ko IS 'pd:personal — 테넌트·임시 항목 이름';
COMMENT ON COLUMN lifecycle_case_items.kind IS 'pd:personal — 항목 종류';
COMMENT ON COLUMN lifecycle_case_items.venue IS 'pd:personal — 처리 장소';
COMMENT ON COLUMN lifecycle_case_items.mode IS 'pd:personal — 처리 방식';
COMMENT ON COLUMN lifecycle_case_items.owner_line IS 'pd:personal — 처리 권한 라인';
COMMENT ON COLUMN lifecycle_case_items.assignee_user_id IS 'pd:personal — 담당자 식별자 - users.id';
COMMENT ON COLUMN lifecycle_case_items.requested_on IS 'pd:personal — 근로자 요청일';
COMMENT ON COLUMN lifecycle_case_items.due_date IS 'pd:personal — 기한';
COMMENT ON COLUMN lifecycle_case_items.due_rule_ref IS 'pd:personal — 기한 규칙 대장 코드';
COMMENT ON COLUMN lifecycle_case_items.due_basis IS 'pd:personal,undeclared — 기한 계산 근거(기준일·대장 행)';
COMMENT ON COLUMN lifecycle_case_items.due_disposition IS 'pd:personal — 기한의 검토 상태(RELEASED/HOLD/UNKNOWN)';
COMMENT ON COLUMN lifecycle_case_items.status IS 'pd:personal — 항목 상태';
COMMENT ON COLUMN lifecycle_case_items.status_code IS 'pd:personal — 상태 사유 코드';
COMMENT ON COLUMN lifecycle_case_items.blocks_close IS 'pd:personal — 종결 차단 여부';
COMMENT ON COLUMN lifecycle_case_items.legal IS 'pd:personal — 법정 항목 여부';
COMMENT ON COLUMN lifecycle_case_items.observed_ref IS 'pd:personal,undeclared — 완료를 관찰한 기록 {table, id}';
COMMENT ON COLUMN lifecycle_case_items.exception_id IS 'pd:personal — 증빙 기록·면제 식별자 - governed_exceptions.id';
COMMENT ON COLUMN lifecycle_case_items.filing_obligation_id IS 'pd:personal — 신고 의무 식별자(SF)';
COMMENT ON COLUMN lifecycle_case_items.done_at IS 'pd:personal — 완료 시각';
COMMENT ON COLUMN lifecycle_case_items.done_by IS 'pd:personal — 처리자 식별자 - users.id';
COMMENT ON COLUMN lifecycle_case_items.version IS 'pd:personal — 동시성 버전';
COMMENT ON COLUMN lifecycle_case_clock_runs.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN lifecycle_case_clock_runs.run_date IS 'pd:none — KST day of the clock run';
COMMENT ON COLUMN lifecycle_case_clock_runs.ran_at IS 'pd:none — when the run claimed the day';

-- ---------------------------------------------------------------------------
-- 5. statutory_rules: the two due numbers the EXIT rows need that the register
-- lacks. HOLD; the code CHECK and console_compliance_domain::statutory::codes
-- list the same set.
ALTER TABLE statutory_rules DROP CONSTRAINT statutory_rules_code_check;
ALTER TABLE statutory_rules ADD CONSTRAINT statutory_rules_code_check CHECK (code IN (
    'FINAL_PAY_DUE_DAYS', 'LATE_WAGE_INTEREST_ANNUAL_RATE', 'DISMISSAL_NOTICE_DAYS',
    'AVERAGE_WAGE_WINDOW_MONTHS', 'EMPLOYMENT_RECORD_RETENTION_YEARS',
    'EMPLOYMENT_CERTIFICATE_REQUEST_YEARS', 'EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS',
    'SEVERANCE_PAY_DUE_DAYS', 'SEVERANCE_MIN_SERVICE_YEARS', 'SEVERANCE_MIN_WEEKLY_HOURS',
    'EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH', 'NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH',
    'NHIS_LOSS_REPORT_DUE_DAYS', 'SEPARATION_CERTIFICATE_DUE_DAYS', 'FIXED_TERM_MAX_YEARS',
    'MANAGERIAL_DISMISSAL_CONSULT_DAYS', 'UNFAIR_DISMISSAL_CLAIM_MONTHS'));

INSERT INTO statutory_rules (
    code, effective_from, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
) VALUES
    ('MANAGERIAL_DISMISSAL_CONSULT_DAYS', DATE '2026-10-02', 'DAYS', 50, 1,
     '근로기준법', '제24조제3항 「해고를 하려는 날의 50일 전까지 사용자가 해고를 피하기 위한 방법과 해고의 기준 등에 관하여 … 근로자대표에게 통보하고 성실하게 협의하여야 한다」',
     '법률 제21857호', DATE '2026-10-02', 'https://www.law.go.kr/법령/근로기준법', DATE '2026-10-07',
     '법령ID 001872, MST 290781, 시행 2026-10-02 현행 슬라이스(law.go.kr DRF, lifecycle-events.md G3)에서 조문 전문을 읽음. 기산(해고하려는 날 전 50일의 계산)은 판단(J). 이 날짜 이전 슬라이스는 아직 인용하지 않았다.'),
    ('UNFAIR_DISMISSAL_CLAIM_MONTHS', DATE '2026-10-02', 'MONTHS', 3, 1,
     '근로기준법', '제28조제2항 「구제신청은 부당해고등이 있었던 날부터 3개월 이내에 하여야 한다」',
     '법률 제21857호', DATE '2026-10-02', 'https://www.law.go.kr/법령/근로기준법', DATE '2026-10-07',
     '법령ID 001872, MST 290781, 시행 2026-10-02 현행 슬라이스(law.go.kr DRF, lifecycle-events.md G6)에서 조문 전문을 읽음. 근로자의 권리 행사 기간으로, 처리 항목이 아니라 관찰 시계(DM5)다.');

-- ---------------------------------------------------------------------------
-- 6. governed_exceptions: attestations and waivers of a case item (LC-B4).
ALTER TABLE governed_exceptions DROP CONSTRAINT governed_exceptions_subject_type_check;
ALTER TABLE governed_exceptions ADD CONSTRAINT governed_exceptions_subject_type_check
    CHECK (subject_type IN (
        'EMPLOYMENT_EVENT', 'ATTENDANCE_RECORD', 'ORG_CHANGE', 'EXIT_CASE', 'EMPLOYEE',
        'USER_ACCOUNT', 'PAYROLL_RUN', 'ORGANIZATION', 'LEGAL_ENTITY', 'BUSINESS_REGISTRATION',
        'PERIOD_LOCK', 'LIFECYCLE_CASE_ITEM'));

-- ---------------------------------------------------------------------------
-- 7. Event-stream vocabulary (#27). One audit row per touched case per daily
-- clock tick (system actor); BE-RT's trigger turns it into change rows. The
-- map exists only once the realtime pair lands, so the rows are written when
-- it does; INTEG must order this after BE-RT or copy the rows into it.
DO $$
BEGIN
    IF to_regclass('public.realtime_topic_map') IS NOT NULL THEN
        INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
            ('lifecycle_case', 'lifecycle_case.clock_tick', 'lifecycle_case', true),
            ('lifecycle_case', 'lifecycle_case.clock_tick', 'lifecycle_case_item', false)
        ON CONFLICT DO NOTHING;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4b. The EXIT template, version 1 (§3.6: 19 base + 17 by reason + GT1-GT4).
-- Structural, so its floor predates any exit on file; each due rule fails
-- closed per item when the register has no row for the date. Every [U] row is
-- UNKNOWN (「기한 미확인」); HOLD rows with a known reading keep the earlier
-- date (#9). Owner lines: 인사 등록·수정 = hr_basic.edit, 급여·정산 = pay.edit,
-- 근태 = attendance.edit, 계정·권한 = access.edit.
INSERT INTO case_templates (template_key, version, kind, effective_from, change_note) VALUES
    ('EXIT', 1, 'EXIT', DATE '1900-01-01',
     'lifecycle-events.md §3.6 (2026-10-07, verified); [U] rows ship 「기한 미확인」; HOLD until 노무사 review');

INSERT INTO case_template_items (template_key, version, item_key, ord, variants, label_ko, kind, venue, mode,
    owner_line, applicability, due_anchor, due_rule_kind, due_register_code, blocks_close, legal,
    instrument_ko, article_ko, basis_tag)
SELECT 'EXIT', 1, v.k, row_number() OVER (), v.variants, v.label, v.kind, v.venue, v.mode, v.owner, v.appl,
       v.anchor, v.rule, v.code, v.blocks, v.legal, v.instrument, v.article, v.tag
FROM (VALUES
    ('X1', NULL::text[], '퇴직일 확정(인사 확인)', 'REC', 'IN_CONSOLE', 'OBSERVED', 'hr_basic.edit', '{}'::text[], 'EXIT_DATE', 'IMMEDIATE', NULL, true, false, NULL, NULL, 'V-REPO'),
    ('X2', NULL, '근로자 명부 퇴직 기재', 'REC', 'IN_CONSOLE', 'OBSERVED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'WITHOUT_DELAY', NULL, true, true, '근로기준법', '제41조제2항; 시행령 제20조제8호', 'V-API'),
    ('X3', NULL, '최종 근태 확정', 'REC', 'IN_CONSOLE', 'ATTESTED', 'attendance.edit', '{}', NULL, 'UNKNOWN', NULL, true, false, NULL, NULL, 'J'),
    ('X4', NULL, '연차 정산(미사용 연차 일수·수당)', 'PAY', 'IN_CONSOLE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'DAYS_AFTER', 'FINAL_PAY_DUE_DAYS', true, true, '근로기준법', '제60조; 대법원 2021다227100', 'V-API'),
    ('X5', NULL, '퇴직금 산정', 'DOC', 'IN_CONSOLE', 'OBSERVED', 'pay.edit', '{SEVERANCE_ELIGIBLE}', 'EXIT_DATE', 'DAYS_AFTER', 'SEVERANCE_PAY_DUE_DAYS', true, true, '근로자퇴직급여 보장법', '제8조제1항, 제4조제1항', 'V-API'),
    ('X6', NULL, '금품청산(최종 임금·수당 지급)', 'PAY', 'OUTSIDE', 'ATTESTED', 'pay.edit', '{}', 'EXIT_DATE', 'DAYS_AFTER', 'FINAL_PAY_DUE_DAYS', true, true, '근로기준법', '제36조, 제37조', 'V-API'),
    ('X7', NULL, '퇴직급여 지급', 'PAY', 'OUTSIDE', 'ATTESTED', 'pay.edit', '{SEVERANCE_ELIGIBLE}', 'EXIT_DATE', 'DAYS_AFTER', 'SEVERANCE_PAY_DUE_DAYS', true, true, '근로자퇴직급여 보장법', '제9조제1항·제2항; 시행령 제3조의2', 'V-API'),
    ('X8', NULL, '최종 임금명세서 교부', 'DOC', 'OUTSIDE', 'ATTESTED', 'pay.edit', '{}', 'EXIT_DATE', 'DAYS_AFTER', 'FINAL_PAY_DUE_DAYS', true, true, '근로기준법', '제48조제2항', 'V-API'),
    ('X9', NULL, '국민연금 상실신고', 'FIL', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{INSURER_APPLIES_NPS}', 'EXIT_DATE', 'DAY_OF_NEXT_MONTH', 'ins.deadline.lose.nps', true, true, '국민연금법', '제12조제1항; 시행규칙 제6조제1항', 'V-REPO'),
    ('X10', NULL, '건강보험 상실신고', 'FIL', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{INSURER_APPLIES_NHIS}', 'EXIT_DATE', 'DAYS_AFTER', 'ins.deadline.lose.nhis', true, true, '국민건강보험법', '제9조제1항제3호·제2항; 시행규칙 제4조제4항제2호', 'V-REPO'),
    ('X11', NULL, '고용·산재 상실신고(상실사유 코드)', 'FIL', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{INSURER_APPLIES_EI}', 'EXIT_DATE', 'DAY_OF_NEXT_MONTH', 'ins.deadline.lose.ei', true, true, '고용보험법 시행령', '제7조제1항; 고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률 제16조의10제4항·제7항', 'V-REPO'),
    ('X12', NULL, '이직확인서 발급', 'DOC', 'OUTSIDE', 'REQUESTED', 'hr_basic.edit', '{!SUBJECT_DECEASED}', 'REQUEST_DATE', 'DAYS_AFTER', 'SEPARATION_CERTIFICATE_DUE_DAYS', false, true, '고용보험법', '제42조제3항; 시행규칙 제82조의2제2항', 'V-API'),
    ('X13', NULL, '사용증명서 발급', 'DOC', 'IN_CONSOLE', 'REQUESTED', 'hr_basic.edit', '{SERVICE_GE_30_DAYS,!SUBJECT_DECEASED}', 'REQUEST_DATE', 'IMMEDIATE', NULL, false, true, '근로기준법', '제39조; 시행령 제19조', 'V-API'),
    ('X14', NULL, '중도퇴사 연말정산·근로소득 원천징수영수증', 'FIL', 'OUTSIDE', 'ATTESTED', 'pay.edit', '{}', 'EXIT_DATE', 'END_OF_NEXT_MONTH', NULL, true, true, '소득세법', '제137조제1항, 제143조제1항', 'V-REPO'),
    ('X15', NULL, '퇴직소득 원천징수영수증', 'DOC', 'OUTSIDE', 'ATTESTED', 'pay.edit', '{SEVERANCE_ELIGIBLE}', 'PAYMENT_DATE', 'END_OF_NEXT_MONTH', NULL, true, true, '소득세법', '제146조제3항', 'V-REPO'),
    ('X16', NULL, '접근 권한 회수', 'ACC', 'IN_CONSOLE', 'OBSERVED', 'access.edit', '{!EMPLOYED_ELSEWHERE_IN_TENANT}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, false, NULL, NULL, 'V-REPO'),
    ('X17', NULL, '서류 보존(명부·계약서·퇴직 서류 3년)', 'REC', 'IN_CONSOLE', 'OBSERVED', NULL, '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '근로기준법', '제42조; 시행령 제22조제2항', 'V-API'),
    ('X18', NULL, '업무 인수인계', 'BACK', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, false, false, NULL, NULL, 'J'),
    ('X19', NULL, '회사 자산·자료 반납', 'BACK', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, false, false, NULL, NULL, 'J'),
    ('RS1', '{RESIGNATION}', '사직서 수령', 'DOC', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '민법', '제660조', 'V-REPO'),
    ('AD1', '{ADVISED}', '권고사직 합의서(확인서)', 'DOC', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, false, NULL, NULL, 'V-REPO'),
    ('AD2', '{ADVISED}', '상실사유 23·26 확정', 'REC', 'IN_CONSOLE', 'OBSERVED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'DAY_OF_NEXT_MONTH', 'ins.deadline.lose.ei', true, false, NULL, NULL, 'V-REPO'),
    ('DM1', '{DISMISSAL_DISCIPLINARY,DISMISSAL_ORDINARY,DISMISSAL_MANAGERIAL}', '해고 보호기간 확인', 'REC', 'IN_CONSOLE', 'OBSERVED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '근로기준법', '제23조제2항; 남녀고용평등과 일·가정 양립 지원에 관한 법률 제19조제3항', 'V-API'),
    ('DM2', '{DISMISSAL_DISCIPLINARY,DISMISSAL_ORDINARY,DISMISSAL_MANAGERIAL}', '해고예고(일자·방법) 또는 단서 사유', 'NOT', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{SERVICE_GE_3_MONTHS}', 'EXIT_DATE', 'DAYS_BEFORE', 'DISMISSAL_NOTICE_DAYS', true, true, '근로기준법', '제26조', 'V-API'),
    ('DM3', '{DISMISSAL_DISCIPLINARY,DISMISSAL_ORDINARY,DISMISSAL_MANAGERIAL}', '해고예고수당', 'PAY', 'OUTSIDE', 'ATTESTED', 'pay.edit', '{}', 'EXIT_DATE', 'DAYS_AFTER', 'FINAL_PAY_DUE_DAYS', true, true, '근로기준법', '제26조', 'V-API'),
    ('DM4', '{DISMISSAL_DISCIPLINARY,DISMISSAL_ORDINARY,DISMISSAL_MANAGERIAL}', '해고 서면통지(사유·시기)', 'NOT', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{HEADCOUNT_5_PLUS}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '근로기준법', '제27조', 'V-API'),
    ('DM5', '{DISMISSAL_DISCIPLINARY,DISMISSAL_ORDINARY,DISMISSAL_MANAGERIAL}', '구제신청 기간(관찰)', 'REC', 'IN_CONSOLE', 'OBSERVED', NULL, '{}', 'EXIT_DATE', 'MONTHS_AFTER', 'UNFAIR_DISMISSAL_CLAIM_MONTHS', false, true, '근로기준법', '제28조제2항', 'V-API'),
    ('DD1', '{DISMISSAL_DISCIPLINARY}', '징계 절차 기록(소명 기회)', 'DOC', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '근로기준법', '제23조제1항', 'V-API'),
    ('DMg1', '{DISMISSAL_MANAGERIAL}', '근로자대표 통보·협의', 'NOT', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'DAYS_BEFORE', 'MANAGERIAL_DISMISSAL_CONSULT_DAYS', true, true, '근로기준법', '제24조제3항', 'V-API'),
    ('DMg2', '{DISMISSAL_MANAGERIAL}', '고용노동부 신고(대통령령 규모)', 'FIL', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', NULL, 'UNKNOWN', NULL, true, true, '근로기준법', '제24조제4항', 'U'),
    ('DMg3', '{DISMISSAL_MANAGERIAL}', '해고 기준·회피 노력 기록', 'DOC', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '근로기준법', '제24조제1항·제2항', 'V-API'),
    ('TE1', '{TERM_END}', '갱신 여부 결정·통지', 'NOT', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', NULL, 'UNKNOWN', NULL, true, false, NULL, NULL, 'U'),
    ('RA1', '{RETIREMENT_AGE}', '정년 도래 확인', 'REC', 'IN_CONSOLE', 'OBSERVED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '고용상 연령차별금지 및 고령자고용촉진에 관한 법률', '제19조', 'V-API'),
    ('DE1', '{DEATH}', '사망 사실·일자 증빙', 'DOC', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '국민연금법', '제12조제1항제1호; 국민건강보험법 제10조제1항제1호', 'V-API'),
    ('CL1', '{CLOSURE}', '폐업 사실·일자(법인 폐업 건 연결)', 'REC', 'IN_CONSOLE', 'OBSERVED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, false, NULL, NULL, 'V-REPO'),
    ('DE2', '{DEATH}', '수령권자(상속인) 확인', 'REC', 'OUTSIDE', 'ATTESTED', 'pay.edit', '{}', 'EXIT_DATE', 'DAYS_AFTER', 'FINAL_PAY_DUE_DAYS', true, true, '근로자퇴직급여 보장법 시행령', '제3조의2제1항제3호', 'V-API'),
    ('GT1', '{GROUP_TRANSFER}', '전적 동의 기록', 'DOC', 'IN_CONSOLE', 'ATTESTED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '민법', '제657조제1항; 대법원 2005두9873', 'V-API'),
    ('GT2', '{GROUP_TRANSFER}', '근속 승계 여부 기록(차원별)', 'REC', 'IN_CONSOLE', 'OBSERVED', 'hr_basic.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, true, true, '대법원 판례', '95다29970; 97다17575', 'V-API'),
    ('GT3', '{GROUP_TRANSFER}', '승계 형태별 지급(정산) 또는 미지급·승계 확인', 'PAY', 'OUTSIDE', 'ATTESTED', 'pay.edit', '{}', 'EXIT_DATE', 'DAYS_AFTER', 'FINAL_PAY_DUE_DAYS', true, true, '근로자퇴직급여 보장법', '제9조; 근로기준법 제36조', 'V-API'),
    ('GT4', '{GROUP_TRANSFER}', 'A 법인 권한 재검토', 'ACC', 'IN_CONSOLE', 'ATTESTED', 'access.edit', '{}', 'EXIT_DATE', 'IMMEDIATE', NULL, false, false, NULL, NULL, 'J')
) AS v(k, variants, label, kind, venue, mode, owner, appl, anchor, rule, code, blocks, legal, instrument, article, tag);

-- ---------------------------------------------------------------------------
-- 8. The exit-case backfill (§5.1). One case per exit case, same id. Nothing
-- is marked done without its fact: X1 needs the APPLIED exit event, X5 a
-- computed settlement package.
--   * CANCELLED / REJECTED                  -> case CANCELLED, no items;
--   * SUBMITTED, or older than today - exit.date.backdate_soft_days
--                                           -> CLOSED; other items NOT_APPLICABLE{PRE_CONSOLE};
--   * otherwise (live)                      -> OPEN; due dates come from the worker's clock tick.
-- Idempotent (one case per exit case; items keyed per case).
CREATE FUNCTION lifecycle_exit_variant(p_reason TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_reason IN ('PERSONAL', 'FAMILY', 'ILLNESS', 'STUDY', 'WORKING_CONDITIONS', 'WAGE_ARREARS', 'RELOCATION')
            THEN 'RESIGNATION'
        WHEN p_reason IN ('ADVISED_RESIGNATION_BUSINESS', 'ADVISED_RESIGNATION_FAULT') THEN 'ADVISED'
        WHEN p_reason = 'DISCIPLINARY_DISMISSAL' THEN 'DISMISSAL_DISCIPLINARY'
        WHEN p_reason = 'REDUNDANCY_DISMISSAL' THEN 'DISMISSAL_MANAGERIAL'
        WHEN p_reason IN ('CONTRACT_END', 'PROJECT_END') THEN 'TERM_END'
        WHEN p_reason = 'RETIREMENT_AGE' THEN 'RETIREMENT_AGE'
        WHEN p_reason = 'DEATH' THEN 'DEATH'
        WHEN p_reason IN ('CLOSURE', 'INSOLVENCY') THEN 'CLOSURE'
        WHEN p_reason = 'GROUP_TRANSFER' THEN 'GROUP_TRANSFER'
    END
$$;

CREATE FUNCTION lifecycle_backfill_exit_cases(p_org UUID) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    v_soft    INT;
    v_floor   DATE;
    v_n       BIGINT := 0;
    v_rows    BIGINT;
    c         RECORD;
    v_variant TEXT;
    v_closed  BOOLEAN;
BEGIN
    SELECT (o.value #>> '{}')::int INTO v_soft FROM tenant_setting_overrides o
    WHERE o.org_id = p_org AND o.key = 'exit.date.backdate_soft_days' AND o.scope_entity_id IS NULL
      AND o.effective_from <= now()
    ORDER BY o.effective_from DESC LIMIT 1;
    v_soft := COALESCE(v_soft, (setting_definition('exit.date.backdate_soft_days')).default_ordinal::int);
    v_floor := (now() AT TIME ZONE 'Asia/Seoul')::date - v_soft;

    FOR c IN
        SELECT x.*, l.state AS exit_event_state,
               EXISTS (SELECT 1 FROM employee_exit_settlement_packages s
                       WHERE s.org_id = x.org_id AND s.exit_case_id = x.id AND s.severance_pay_won IS NOT NULL) AS computed,
               (SELECT s.id FROM employee_exit_settlement_packages s
                WHERE s.org_id = x.org_id AND s.exit_case_id = x.id) AS package_id
        FROM employee_exit_cases x
        LEFT JOIN employee_lifecycle_events l ON l.org_id = x.org_id AND l.id = x.exit_lifecycle_event_id
        WHERE x.org_id = p_org
          AND NOT EXISTS (SELECT 1 FROM lifecycle_cases k WHERE k.org_id = x.org_id AND k.id = x.id)
        ORDER BY x.id
    LOOP
        v_variant := lifecycle_exit_variant(c.exit_reason_code);
        INSERT INTO lifecycle_cases (org_id, id, kind, variant, subject_kind, employee_id, employment_id, branch_id,
            trigger_kind, trigger_id, effective_date, template_key, template_version, opened_by, opened_at,
            settings_snapshot)
        SELECT p_org, c.id, 'EXIT', v_variant, 'EMPLOYMENT', c.employee_id, c.employment_id, c.branch_id,
               'EXIT_CASE', c.id, c.effective_exit_date, t.template_key, t.version, c.reported_by, c.reported_at,
               jsonb_build_object('exit.date.backdate_soft_days', v_soft, 'backfill', 'LC-B3')
        FROM case_templates t
        WHERE t.kind = 'EXIT' AND t.effective_from <= c.effective_exit_date
          AND (t.effective_to_exclusive IS NULL OR c.effective_exit_date < t.effective_to_exclusive)
        ORDER BY t.effective_from DESC LIMIT 1;
        v_n := v_n + 1;

        IF c.status IN ('CANCELLED', 'REJECTED') THEN
            UPDATE lifecycle_cases SET state = 'CANCELLED', closed_at = COALESCE(c.closed_at, now())
            WHERE org_id = p_org AND id = c.id;
            CONTINUE;
        END IF;
        v_closed := c.status = 'SUBMITTED' OR c.effective_exit_date < v_floor;

        INSERT INTO lifecycle_case_items (org_id, case_id, item_key, source, template_item_version, kind, venue,
            mode, owner_line, due_rule_ref, due_disposition, status, status_code, blocks_close, legal,
            observed_ref, done_at)
        SELECT p_org, c.id, ti.item_key, 'TEMPLATE', ti.version, ti.kind, ti.venue, ti.mode, ti.owner_line,
               ti.due_register_code,
               CASE WHEN ti.due_rule_kind = 'UNKNOWN' THEN 'UNKNOWN' ELSE t.release_disposition END,
               d.status, d.code, ti.blocks_close, ti.legal, d.ref,
               CASE WHEN d.status IN ('DONE_OBSERVED', 'NOT_APPLICABLE') THEN now() END
        FROM lifecycle_cases k
        JOIN case_templates t ON t.template_key = k.template_key AND t.version = k.template_version
        JOIN case_template_items ti ON ti.template_key = t.template_key AND ti.version = t.version
        CROSS JOIN LATERAL (SELECT
            CASE WHEN ti.item_key = 'X1' AND c.exit_event_state = 'APPLIED'
                     THEN jsonb_build_object('table', 'employee_lifecycle_events', 'id', c.exit_lifecycle_event_id)
                 WHEN ti.item_key = 'X5' AND c.computed
                     THEN jsonb_build_object('table', 'employee_exit_settlement_packages', 'id', c.package_id)
            END AS ref) o
        CROSS JOIN LATERAL (SELECT
            CASE WHEN o.ref IS NOT NULL THEN 'DONE_OBSERVED'
                 WHEN v_closed THEN 'NOT_APPLICABLE'
                 WHEN ti.mode = 'REQUESTED' THEN 'PENDING_TRIGGER'
                 ELSE 'OPEN' END AS status,
            CASE WHEN o.ref IS NULL AND v_closed THEN 'PRE_CONSOLE' END AS code,
            o.ref) d
        WHERE k.org_id = p_org AND k.id = c.id
          AND (ti.variants IS NULL OR k.variant = ANY (ti.variants))
        ORDER BY ti.ord;
        GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;

        IF v_closed THEN
            UPDATE lifecycle_cases SET state = 'CLOSED', closed_at = now(), close_basis = 'ALL_TERMINAL'
            WHERE org_id = p_org AND id = c.id;
        END IF;
    END LOOP;
    RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION lifecycle_backfill_exit_cases(UUID) FROM PUBLIC;

SELECT lifecycle_backfill_exit_cases(o.id) FROM organizations o ORDER BY o.id;
