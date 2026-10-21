-- ATT-BUILD S1 (decision #22, AT §4.2, frames A2-*): 근무 일정 — patterns,
-- effective-dated layers (법인 · 사업장 · 부서 · 근무조 · 사람), 근무조 with
-- dated membership, 약정휴일, and the bundled 공휴일 reference rows.
-- Layers are append-only: a new layer from a later date supersedes the one
-- before it at the same scope; a layer not yet in effect may be cancelled.
-- Numbered head+1 of console-react-mvp b9fe1354 (trunk ends at 0318); INTEG
-- renumbers.
SET LOCAL lock_timeout = '2s';

-- console-gate: audited-table attendance_work_patterns
CREATE TABLE attendance_work_patterns (
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    name                TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    kind                TEXT        NOT NULL CHECK (kind IN ('WEEKLY', 'ROTATION', 'STAGGERED')),
    spec                JSONB       NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
    weekly_minutes      INTEGER     NOT NULL CHECK (weekly_minutes BETWEEN 0 AND 2400),
    cycle_days          SMALLINT    NOT NULL CHECK (cycle_days BETWEEN 1 AND 56),
    status              TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
    retired_at          TIMESTAMPTZ NULL,
    retired_by          UUID        NULL,
    created_by          UUID        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    idempotency_key     TEXT        NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
    request_fingerprint TEXT        NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (id, org_id),
    UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (retired_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL AND retired_by IS NOT NULL))
);
CREATE UNIQUE INDEX attendance_work_patterns_name_uniq
    ON attendance_work_patterns (org_id, lower(btrim(name))) WHERE status = 'ACTIVE';

-- console-gate: audited-table attendance_crews
CREATE TABLE attendance_crews (
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    workplace_id        UUID        NOT NULL,
    name                TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
    status              TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
    created_by          UUID        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    idempotency_key     TEXT        NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
    request_fingerprint TEXT        NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (id, org_id),
    UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX attendance_crews_name_uniq
    ON attendance_crews (org_id, workplace_id, lower(btrim(name))) WHERE status = 'ACTIVE';

-- One row per dated membership. A move from one 근무조 to another ends the old
-- row (valid_to) and adds a new one in the same command.
-- console-gate: audited-table attendance_crew_members
CREATE TABLE attendance_crew_members (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id          UUID        NOT NULL DEFAULT gen_random_uuid(),
    crew_id     UUID        NOT NULL,
    employee_id UUID        NOT NULL,
    valid_from  DATE        NOT NULL,
    valid_to    DATE        NULL,
    created_by  UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    FOREIGN KEY (crew_id, org_id) REFERENCES attendance_crews(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- One person is in at most one 근무조 on any day (a trigger: btree_gist is not
-- installed, see 0253). The advisory lock serialises writers per person.
CREATE FUNCTION attendance_crew_members_one_crew() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text || NEW.employee_id::text, 7319));
    IF EXISTS (SELECT 1 FROM attendance_crew_members m
                WHERE m.org_id = NEW.org_id AND m.employee_id = NEW.employee_id AND m.id <> NEW.id
                  AND daterange(m.valid_from, m.valid_to) && daterange(NEW.valid_from, NEW.valid_to)) THEN
        RAISE EXCEPTION 'crew_membership_overlap' USING ERRCODE = '23P01';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_attendance_crew_members_one_crew
    BEFORE INSERT OR UPDATE ON attendance_crew_members FOR EACH ROW EXECUTE FUNCTION attendance_crew_members_one_crew();

-- console-gate: audited-table attendance_schedule_layers
CREATE TABLE attendance_schedule_layers (
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    scope_kind          TEXT        NOT NULL CHECK (scope_kind IN ('LEGAL_ENTITY', 'WORKPLACE', 'DEPARTMENT', 'CREW', 'PERSON')),
    legal_entity_id     UUID        NULL,
    workplace_id        UUID        NULL,
    org_unit_id         UUID        NULL,
    crew_id             UUID        NULL,
    employee_id         UUID        NULL,
    pattern_id          UUID        NOT NULL,
    effective_from      DATE        NOT NULL,
    -- Exclusive end for a bounded layer (a one-day 대신 근무, a dated 단축).
    effective_to        DATE        NULL,
    rotation_start      DATE        NULL,
    start_choice        SMALLINT    NULL CHECK (start_choice IS NULL OR start_choice BETWEEN 0 AND 1439),
    reason              TEXT        NOT NULL DEFAULT 'STANDARD'
        CHECK (reason IN ('STANDARD', 'REDUCTION', 'SUBSTITUTE', 'TEMPORARY')),
    evidence_ref        TEXT        NULL CHECK (evidence_ref IS NULL OR char_length(btrim(evidence_ref)) BETWEEN 1 AND 200),
    version             INTEGER     NOT NULL CHECK (version >= 1),
    status              TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
    cancel_reason       TEXT        NULL,
    cancelled_by        UUID        NULL,
    cancelled_at        TIMESTAMPTZ NULL,
    created_by          UUID        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    idempotency_key     TEXT        NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
    request_fingerprint TEXT        NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (id, org_id),
    FOREIGN KEY (pattern_id, org_id) REFERENCES attendance_work_patterns(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, org_unit_id) REFERENCES org_units(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (crew_id, org_id) REFERENCES attendance_crews(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (cancelled_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CHECK (effective_to IS NULL OR effective_to > effective_from),
    CHECK (num_nonnulls(legal_entity_id, workplace_id, org_unit_id, crew_id, employee_id) = 1),
    CHECK ((scope_kind = 'LEGAL_ENTITY') = (legal_entity_id IS NOT NULL)
       AND (scope_kind = 'WORKPLACE') = (workplace_id IS NOT NULL)
       AND (scope_kind = 'DEPARTMENT') = (org_unit_id IS NOT NULL)
       AND (scope_kind = 'CREW') = (crew_id IS NOT NULL)
       AND (scope_kind = 'PERSON') = (employee_id IS NOT NULL)),
    CHECK (start_choice IS NULL OR scope_kind = 'PERSON'),
    CHECK ((status = 'CANCELLED') = (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
);
CREATE UNIQUE INDEX attendance_schedule_layers_idem ON attendance_schedule_layers (org_id, idempotency_key, id);
CREATE INDEX attendance_schedule_layers_scope_idx ON attendance_schedule_layers
    (org_id, scope_kind, COALESCE(legal_entity_id, workplace_id, org_unit_id, crew_id, employee_id), effective_from)
    WHERE status = 'ACTIVE';
CREATE INDEX attendance_schedule_layers_pattern_idx ON attendance_schedule_layers (org_id, pattern_id) WHERE status = 'ACTIVE';

-- console-gate: audited-table attendance_contractual_holidays
CREATE TABLE attendance_contractual_holidays (
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    name                TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
    rule_kind           TEXT        NOT NULL CHECK (rule_kind IN ('DATE', 'YEARLY')),
    on_date             DATE        NULL,
    month               SMALLINT    NULL CHECK (month IS NULL OR month BETWEEN 1 AND 12),
    day                 SMALLINT    NULL CHECK (day IS NULL OR day BETWEEN 1 AND 31),
    paid                BOOLEAN     NOT NULL,
    scope_kind          TEXT        NOT NULL CHECK (scope_kind IN ('LEGAL_ENTITY', 'WORKPLACE')),
    legal_entity_id     UUID        NULL,
    workplace_id        UUID        NULL,
    basis_kind          TEXT        NOT NULL CHECK (basis_kind IN ('WORK_RULES', 'COLLECTIVE_AGREEMENT')),
    basis_ref           TEXT        NOT NULL CHECK (char_length(btrim(basis_ref)) BETWEEN 1 AND 100),
    start_year          SMALLINT    NOT NULL CHECK (start_year BETWEEN 2000 AND 2100),
    end_year            SMALLINT    NULL CHECK (end_year IS NULL OR end_year >= start_year - 1),
    created_by          UUID        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    idempotency_key     TEXT        NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
    request_fingerprint TEXT        NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (id, org_id),
    UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CHECK ((rule_kind = 'DATE') = (on_date IS NOT NULL) AND (rule_kind = 'YEARLY') = (month IS NOT NULL AND day IS NOT NULL)),
    CHECK ((scope_kind = 'LEGAL_ENTITY') = (legal_entity_id IS NOT NULL AND workplace_id IS NULL)
       AND (scope_kind = 'WORKPLACE') = (workplace_id IS NOT NULL AND legal_entity_id IS NULL))
);

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['attendance_work_patterns', 'attendance_crews', 'attendance_crew_members',
                             'attendance_schedule_layers', 'attendance_contractual_holidays'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid)', t);
        EXECUTE format('CREATE TRIGGER trg_%I_org_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable()', t, t);
        EXECUTE format('REVOKE ALL PRIVILEGES ON %I FROM PUBLIC, console_rt', t);
    END LOOP;
END $$;
GRANT SELECT, INSERT ON attendance_work_patterns, attendance_crews, attendance_crew_members,
    attendance_schedule_layers, attendance_contractual_holidays TO console_rt;
GRANT UPDATE (status, retired_at, retired_by) ON attendance_work_patterns TO console_rt;
GRANT UPDATE (status) ON attendance_crews TO console_rt;
GRANT UPDATE (valid_to) ON attendance_crew_members TO console_rt;
GRANT UPDATE (status, cancel_reason, cancelled_by, cancelled_at) ON attendance_schedule_layers TO console_rt;
GRANT UPDATE (end_year) ON attendance_contractual_holidays TO console_rt;

-- A layer only goes ACTIVE -> CANCELLED, and only before it takes effect (KST).
CREATE FUNCTION attendance_schedule_layer_cancel_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'ACTIVE' OR NEW.status <> 'CANCELLED'
       OR (NEW.id, NEW.org_id, NEW.scope_kind, NEW.pattern_id, NEW.effective_from, NEW.version, NEW.created_by)
          IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.scope_kind, OLD.pattern_id, OLD.effective_from, OLD.version, OLD.created_by)
       OR OLD.effective_from <= (now() AT TIME ZONE 'Asia/Seoul')::date
    THEN
        RAISE EXCEPTION 'attendance schedule layer only cancels before it takes effect' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_attendance_schedule_layers_cancel_only
    BEFORE UPDATE ON attendance_schedule_layers FOR EACH ROW EXECUTE FUNCTION attendance_schedule_layer_cancel_only();
CREATE FUNCTION attendance_schedule_layer_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'attendance schedule layers are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_attendance_schedule_layers_no_delete
    BEFORE DELETE ON attendance_schedule_layers FOR EACH ROW EXECUTE FUNCTION attendance_schedule_layer_no_delete();

-- Bundled reference data (FE-15): 관공서의 공휴일에 관한 규정 §2 (제1호 일요일
-- 제외, 근로기준법 시행령 §30②) and §3 대체공휴일, plus 노동절 (its own act,
-- 대체 없음). Global and migration-only, like statutory_rules. A year with no
-- row is NOT LOADED and the screens say so; it is never guessed.
CREATE TABLE attendance_public_holidays (
    holiday_date   DATE PRIMARY KEY,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('NATIONAL', 'SUBSTITUTE', 'ELECTION', 'LABOR_DAY')),
    substitute_for DATE NULL,
    basis          TEXT NOT NULL,
    edition        TEXT NOT NULL,
    CHECK ((kind = 'SUBSTITUTE') = (substitute_for IS NOT NULL))
);
REVOKE ALL PRIVILEGES ON attendance_public_holidays FROM PUBLIC, console_rt;
GRANT SELECT ON attendance_public_holidays TO console_rt;
INSERT INTO attendance_public_holidays (holiday_date, name, kind, substitute_for, basis, edition) VALUES
    ('2026-01-01', '1월 1일', 'NATIONAL', NULL, '관공서 규정 제2조 제2호', '2026'),
    ('2026-02-16', '설날 연휴', 'NATIONAL', NULL, '관공서 규정 제2조 제4호', '2026'),
    ('2026-02-17', '설날', 'NATIONAL', NULL, '관공서 규정 제2조 제4호', '2026'),
    ('2026-02-18', '설날 연휴', 'NATIONAL', NULL, '관공서 규정 제2조 제4호', '2026'),
    ('2026-03-01', '삼일절', 'NATIONAL', NULL, '관공서 규정 제2조 제2호', '2026'),
    ('2026-03-02', '삼일절 대체공휴일', 'SUBSTITUTE', '2026-03-01', '관공서 규정 제3조 제1항 제1호', '2026'),
    ('2026-05-01', '노동절', 'LABOR_DAY', NULL, '노동절 제정에 관한 법률 · 대체 없음', '2026'),
    ('2026-05-05', '어린이날', 'NATIONAL', NULL, '관공서 규정 제2조 제6호', '2026'),
    ('2026-05-24', '부처님 오신 날', 'NATIONAL', NULL, '관공서 규정 제2조 제5호', '2026'),
    ('2026-05-25', '부처님 오신 날 대체공휴일', 'SUBSTITUTE', '2026-05-24', '관공서 규정 제3조 제1항 제1호', '2026'),
    ('2026-06-03', '전국동시지방선거일', 'ELECTION', NULL, '관공서 규정 제2조 제9호', '2026'),
    ('2026-06-06', '현충일', 'NATIONAL', NULL, '관공서 규정 제2조 제7호 · 대체 없음', '2026'),
    ('2026-07-17', '제헌절', 'NATIONAL', NULL, '관공서 규정 제2조 제2호', '2026'),
    ('2026-08-15', '광복절', 'NATIONAL', NULL, '관공서 규정 제2조 제2호', '2026'),
    ('2026-08-17', '광복절 대체공휴일', 'SUBSTITUTE', '2026-08-15', '관공서 규정 제3조 제1항 제1호', '2026'),
    ('2026-09-24', '추석 연휴', 'NATIONAL', NULL, '관공서 규정 제2조 제8호', '2026'),
    ('2026-09-25', '추석', 'NATIONAL', NULL, '관공서 규정 제2조 제8호', '2026'),
    ('2026-09-26', '추석 연휴', 'NATIONAL', NULL, '관공서 규정 제2조 제8호 · 대체 없음', '2026'),
    ('2026-10-03', '개천절', 'NATIONAL', NULL, '관공서 규정 제2조 제2호', '2026'),
    ('2026-10-05', '개천절 대체공휴일', 'SUBSTITUTE', '2026-10-03', '관공서 규정 제3조 제1항 제1호', '2026'),
    ('2026-10-09', '한글날', 'NATIONAL', NULL, '관공서 규정 제2조 제2호', '2026'),
    ('2026-12-25', '기독탄신일', 'NATIONAL', NULL, '관공서 규정 제2조 제10호', '2026');

COMMENT ON TABLE attendance_work_patterns IS 'ATT S1: 근무 유형 (weekly, rotation, staggered) with derived weekly minutes and cycle';
COMMENT ON COLUMN attendance_work_patterns.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN attendance_work_patterns.id IS 'pd:none — pattern id';
COMMENT ON COLUMN attendance_work_patterns.name IS 'pd:none — pattern name';
COMMENT ON COLUMN attendance_work_patterns.kind IS 'pd:none — WEEKLY | ROTATION | STAGGERED';
COMMENT ON COLUMN attendance_work_patterns.spec IS 'pd:none — days or slots: 시업, 종업, 휴게 in minutes';
COMMENT ON COLUMN attendance_work_patterns.weekly_minutes IS 'pd:none — 주 소정 (rotation: cycle average)';
COMMENT ON COLUMN attendance_work_patterns.cycle_days IS 'pd:none — 주기 일수, derived';
COMMENT ON COLUMN attendance_work_patterns.status IS 'pd:none — ACTIVE | RETIRED (사용 중지)';
COMMENT ON COLUMN attendance_work_patterns.retired_at IS 'pd:none — when retired';
COMMENT ON COLUMN attendance_work_patterns.retired_by IS 'pd:personal — who retired it';
COMMENT ON COLUMN attendance_work_patterns.created_by IS 'pd:personal — who added it';
COMMENT ON COLUMN attendance_work_patterns.created_at IS 'pd:none — when added';
COMMENT ON COLUMN attendance_work_patterns.idempotency_key IS 'pd:none — request key';
COMMENT ON COLUMN attendance_work_patterns.request_fingerprint IS 'pd:none — request digest';
COMMENT ON TABLE attendance_crews IS 'ATT S1: 근무조 of a 사업장';
COMMENT ON COLUMN attendance_crews.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN attendance_crews.id IS 'pd:none — crew id';
COMMENT ON COLUMN attendance_crews.workplace_id IS 'pd:none — its 사업장';
COMMENT ON COLUMN attendance_crews.name IS 'pd:none — crew name';
COMMENT ON COLUMN attendance_crews.status IS 'pd:none — ACTIVE | RETIRED';
COMMENT ON COLUMN attendance_crews.created_by IS 'pd:personal — who added it';
COMMENT ON COLUMN attendance_crews.created_at IS 'pd:none — when added';
COMMENT ON COLUMN attendance_crews.idempotency_key IS 'pd:none — request key';
COMMENT ON COLUMN attendance_crews.request_fingerprint IS 'pd:none — request digest';
COMMENT ON TABLE attendance_crew_members IS 'ATT S1: dated 근무조 membership';
COMMENT ON COLUMN attendance_crew_members.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN attendance_crew_members.id IS 'pd:none — membership id';
COMMENT ON COLUMN attendance_crew_members.crew_id IS 'pd:none — the crew';
COMMENT ON COLUMN attendance_crew_members.employee_id IS 'pd:personal — 직원 레코드 식별자 - employees.id';
COMMENT ON COLUMN attendance_crew_members.valid_from IS 'pd:personal — first day in the crew';
COMMENT ON COLUMN attendance_crew_members.valid_to IS 'pd:personal — first day out of the crew';
COMMENT ON COLUMN attendance_crew_members.created_by IS 'pd:personal — who recorded it';
COMMENT ON COLUMN attendance_crew_members.created_at IS 'pd:none — when recorded';
COMMENT ON TABLE attendance_schedule_layers IS 'ATT S1: one dated assignment of a pattern to a scope; append-only';
COMMENT ON COLUMN attendance_schedule_layers.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN attendance_schedule_layers.id IS 'pd:none — layer id';
COMMENT ON COLUMN attendance_schedule_layers.scope_kind IS 'pd:none — LEGAL_ENTITY | WORKPLACE | DEPARTMENT | CREW | PERSON';
COMMENT ON COLUMN attendance_schedule_layers.legal_entity_id IS 'pd:none — 법인 scope';
COMMENT ON COLUMN attendance_schedule_layers.workplace_id IS 'pd:none — 사업장 scope';
COMMENT ON COLUMN attendance_schedule_layers.org_unit_id IS 'pd:none — 부서 scope';
COMMENT ON COLUMN attendance_schedule_layers.crew_id IS 'pd:none — 근무조 scope';
COMMENT ON COLUMN attendance_schedule_layers.employee_id IS 'pd:personal — 직원 레코드 식별자 - employees.id (사람 scope)';
COMMENT ON COLUMN attendance_schedule_layers.pattern_id IS 'pd:none — the pattern';
COMMENT ON COLUMN attendance_schedule_layers.effective_from IS 'pd:none — 적용 시작일';
COMMENT ON COLUMN attendance_schedule_layers.effective_to IS 'pd:none — exclusive end of a bounded layer';
COMMENT ON COLUMN attendance_schedule_layers.rotation_start IS 'pd:none — 회전 시작일';
COMMENT ON COLUMN attendance_schedule_layers.start_choice IS 'pd:personal — a person''s 시차 출근 시각';
COMMENT ON COLUMN attendance_schedule_layers.reason IS 'pd:personal — STANDARD | REDUCTION (단축) | SUBSTITUTE (대신 근무) | TEMPORARY';
COMMENT ON COLUMN attendance_schedule_layers.evidence_ref IS 'pd:personal — 근거 문서';
COMMENT ON COLUMN attendance_schedule_layers.version IS 'pd:none — n-th layer at this scope';
COMMENT ON COLUMN attendance_schedule_layers.status IS 'pd:none — ACTIVE | CANCELLED';
COMMENT ON COLUMN attendance_schedule_layers.cancel_reason IS 'pd:personal — why it was cancelled';
COMMENT ON COLUMN attendance_schedule_layers.cancelled_by IS 'pd:personal — who cancelled it';
COMMENT ON COLUMN attendance_schedule_layers.cancelled_at IS 'pd:none — when cancelled';
COMMENT ON COLUMN attendance_schedule_layers.created_by IS 'pd:personal — who assigned it';
COMMENT ON COLUMN attendance_schedule_layers.created_at IS 'pd:none — when assigned';
COMMENT ON COLUMN attendance_schedule_layers.idempotency_key IS 'pd:none — request key (one command may write several layers)';
COMMENT ON COLUMN attendance_schedule_layers.request_fingerprint IS 'pd:none — request digest';
COMMENT ON TABLE attendance_contractual_holidays IS 'ATT S1: 약정휴일 from 취업규칙 or 단체협약';
COMMENT ON COLUMN attendance_contractual_holidays.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN attendance_contractual_holidays.id IS 'pd:none — holiday id';
COMMENT ON COLUMN attendance_contractual_holidays.name IS 'pd:none — holiday name';
COMMENT ON COLUMN attendance_contractual_holidays.rule_kind IS 'pd:none — DATE | YEARLY';
COMMENT ON COLUMN attendance_contractual_holidays.on_date IS 'pd:none — the date (DATE rule)';
COMMENT ON COLUMN attendance_contractual_holidays.month IS 'pd:none — month (YEARLY rule)';
COMMENT ON COLUMN attendance_contractual_holidays.day IS 'pd:none — day (YEARLY rule)';
COMMENT ON COLUMN attendance_contractual_holidays.paid IS 'pd:none — 유급';
COMMENT ON COLUMN attendance_contractual_holidays.scope_kind IS 'pd:none — LEGAL_ENTITY | WORKPLACE';
COMMENT ON COLUMN attendance_contractual_holidays.legal_entity_id IS 'pd:none — 법인 scope';
COMMENT ON COLUMN attendance_contractual_holidays.workplace_id IS 'pd:none — 사업장 scope';
COMMENT ON COLUMN attendance_contractual_holidays.basis_kind IS 'pd:none — WORK_RULES | COLLECTIVE_AGREEMENT';
COMMENT ON COLUMN attendance_contractual_holidays.basis_ref IS 'pd:none — 조항';
COMMENT ON COLUMN attendance_contractual_holidays.start_year IS 'pd:none — first year';
COMMENT ON COLUMN attendance_contractual_holidays.end_year IS 'pd:none — last year (사용 중지)';
COMMENT ON COLUMN attendance_contractual_holidays.created_by IS 'pd:personal — who added it';
COMMENT ON COLUMN attendance_contractual_holidays.created_at IS 'pd:none — when added';
COMMENT ON COLUMN attendance_contractual_holidays.idempotency_key IS 'pd:none — request key';
COMMENT ON COLUMN attendance_contractual_holidays.request_fingerprint IS 'pd:none — request digest';
COMMENT ON TABLE attendance_public_holidays IS 'ATT S1: bundled 공휴일 reference rows, global, migration-only';
COMMENT ON COLUMN attendance_public_holidays.holiday_date IS 'pd:none — date';
COMMENT ON COLUMN attendance_public_holidays.name IS 'pd:none — name';
COMMENT ON COLUMN attendance_public_holidays.kind IS 'pd:none — NATIONAL | SUBSTITUTE | ELECTION | LABOR_DAY';
COMMENT ON COLUMN attendance_public_holidays.substitute_for IS 'pd:none — the holiday a 대체공휴일 replaces';
COMMENT ON COLUMN attendance_public_holidays.basis IS 'pd:none — legal basis';
COMMENT ON COLUMN attendance_public_holidays.edition IS 'pd:none — reference data edition';

-- #27: every schedule write re-reads the 근무 일정 views.
DO $$
BEGIN
    IF to_regclass('public.realtime_topic_map') IS NOT NULL THEN
        INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
            ('attendance_work_pattern', 'attendance.pattern.create', 'attendance_schedule', false),
            ('attendance_work_pattern', 'attendance.pattern.retire', 'attendance_schedule', false),
            ('attendance_schedule_layer', 'attendance.schedule.assign', 'attendance_schedule', false),
            ('attendance_schedule_layer', 'attendance.schedule.cancel', 'attendance_schedule', false),
            ('attendance_crew', 'attendance.crew.create', 'attendance_schedule', false),
            ('attendance_crew', 'attendance.crew.members', 'attendance_schedule', false),
            ('attendance_contractual_holiday', 'attendance.holiday.create', 'attendance_schedule', false),
            ('attendance_contractual_holiday', 'attendance.holiday.retire', 'attendance_schedule', false)
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
