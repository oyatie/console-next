-- 회사 구조 screens (decisions #18, #21; structure-ux review R15, R16): the
-- 사업장 code and the sibling order of 사업장 and 부서. Both are labels, so
-- they are changed in place and audited in both phases, never dated
-- (onboarding-and-migration §7.2). Numbered head+1 of this lane's base
-- (ENT-KIND, 0263); INTEG renumbers it.
SET LOCAL lock_timeout = '2s';

-- 1. 사업장 code: optional, the same rule as 부서 코드 (1-30 letters,
--    digits, '.', '_', '-'; exact match), unique among the tenant's open
--    사업장. A closed or voided 사업장 frees its code; reuse is allowed (the
--    writer warns, review R17).
ALTER TABLE workplaces ADD COLUMN code TEXT NULL
    CHECK (code IS NULL OR code ~ '^[A-Za-z0-9._-]{1,30}$');
CREATE UNIQUE INDEX workplaces_code_open_uniq ON workplaces (org_id, code)
    WHERE code IS NOT NULL AND voided_at IS NULL AND closed_on IS NULL;
COMMENT ON COLUMN workplaces.code IS 'pd:none — 사업장 code (label; unique among open 사업장); NULL = none';

-- 2. 사업장 order inside its 법인. NULL sorts after every set position
--    (then by creation), so a new 사업장 lands last.
ALTER TABLE workplaces ADD COLUMN sort_order INTEGER NULL CHECK (sort_order IS NULL OR sort_order >= 0);
COMMENT ON COLUMN workplaces.sort_order IS 'pd:none — position among the 법인''s 사업장 (label); NULL = after the ordered ones';
GRANT UPDATE (code, sort_order) ON workplaces TO console_rt;

-- 3. 부서 order among its siblings. Kept beside the canonical unit, not in
--    its revisions: a reorder is a label and must not bump the version that
--    setup batches and org changes pin (MR-12 expected_version).
CREATE TABLE org_unit_positions (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    org_unit_id UUID        NOT NULL,
    position    INTEGER     NOT NULL CHECK (position >= 0),
    updated_by  UUID        NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, org_unit_id),
    FOREIGN KEY (org_id, org_unit_id) REFERENCES org_units (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT
);
ALTER TABLE org_unit_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_unit_positions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org_unit_positions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_org_unit_positions_org_immutable BEFORE UPDATE ON org_unit_positions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
REVOKE ALL PRIVILEGES ON org_unit_positions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON org_unit_positions TO console_rt;
GRANT UPDATE (position, updated_by, updated_at) ON org_unit_positions TO console_rt;
COMMENT ON TABLE org_unit_positions IS '부서 order among its siblings (label; decisions #21, review R15)';
COMMENT ON COLUMN org_unit_positions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN org_unit_positions.org_unit_id IS 'pd:none — the 부서';
COMMENT ON COLUMN org_unit_positions.position IS 'pd:none — 0-based position among the siblings; units without a row sort after, by name';
COMMENT ON COLUMN org_unit_positions.updated_by IS 'pd:personal — user who last reordered';
COMMENT ON COLUMN org_unit_positions.updated_at IS 'pd:none — last reorder time';
