-- MR-19 / MR-20 (decisions #18): the 사업장 kind, a tenant-editable code
-- list, and the mapping of legacy 지점 (branches) onto their 사업장.
-- Numbered head+1 of this lane's base (ENT-ORG, 0262); INTEG renumbers it.
--
-- 1. workplace_kinds: the tenant's own kinds, plus a tenant's override of a
--    platform default. The platform defaults (본사, 사업장, 공장, 지점, 영업소,
--    연구소, 물류센터, 매장) are constants in console-entity-domain with their
--    labels in the ko/en catalogs, so no row is written for them (no seed
--    rows). A row whose code is a platform code (UPPER_SNAKE) only relabels
--    (label NULL = the catalog label) or hides it; a tenant kind has a
--    server-generated UUID code and its own label. The kind is a label only
--    and changes no rule (#18), so it is never deleted: it is deactivated,
--    and a 사업장 keeps reading a deactivated kind.
SET LOCAL lock_timeout = '2s';

CREATE TABLE workplace_kinds (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code       TEXT        NOT NULL CHECK (code ~ '^[A-Z][A-Z_]{1,39}$'
                                 OR code ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    label      TEXT        NULL CHECK (label IS NULL OR (label = btrim(label) AND char_length(label) BETWEEN 1 AND 40)),
    active     BOOLEAN     NOT NULL DEFAULT true,
    created_by UUID        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, code),
    CONSTRAINT workplace_kinds_tenant_label CHECK (label IS NOT NULL OR code ~ '^[A-Z]'),
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT
);
-- Two kinds of one tenant never share a label (case-insensitive).
CREATE UNIQUE INDEX workplace_kinds_label_uniq ON workplace_kinds (org_id, lower(label)) WHERE label IS NOT NULL;

ALTER TABLE workplace_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplace_kinds FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workplace_kinds
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_workplace_kinds_org_immutable BEFORE UPDATE ON workplace_kinds
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
REVOKE ALL PRIVILEGES ON workplace_kinds FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON workplace_kinds TO console_rt;
GRANT UPDATE (label, active, updated_at) ON workplace_kinds TO console_rt;
COMMENT ON TABLE workplace_kinds IS '사업장 kind code list: tenant kinds and overrides of the platform defaults (decisions #18; label only)';
COMMENT ON COLUMN workplace_kinds.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN workplace_kinds.code IS 'pd:none — platform code (UPPER_SNAKE) or a server-generated tenant code (UUID)';
COMMENT ON COLUMN workplace_kinds.label IS 'pd:none — the tenant''s label; NULL on a platform code = the catalog label';
COMMENT ON COLUMN workplace_kinds.active IS 'pd:none — offered in the picker; a deactivated kind stays readable on 사업장';
COMMENT ON COLUMN workplace_kinds.created_by IS 'pd:personal — user who added the kind or override';
COMMENT ON COLUMN workplace_kinds.created_at IS 'pd:none — row creation time';
COMMENT ON COLUMN workplace_kinds.updated_at IS 'pd:none — last label or active change';

-- 2. The kind on the 사업장 head: a label, so it is changed in place and
--    audited, not dated (onboarding-and-migration §7.2). NULL = 미지정.
--    No foreign key: a platform code has no row; the writer checks it.
ALTER TABLE workplaces ADD COLUMN kind_code TEXT NULL
    CHECK (kind_code IS NULL OR char_length(kind_code) BETWEEN 2 AND 40);
GRANT UPDATE (kind_code) ON workplaces TO console_rt;
COMMENT ON COLUMN workplaces.kind_code IS 'pd:none — 사업장 kind code (workplace_kinds or a platform default); NULL = not chosen';

-- 3. Legacy 지점 → 사업장 (decisions #18: 지역 and 지점 are retired as
--    separate concepts; existing data maps through the org-unit source
--    bindings). A branch bound by the old 지점 flow (`('branch', id)` in
--    org_unit_source_bindings) that now backs a live 사업장:
--    * the 사업장 gets kind 지점 (BRANCH) unless it already has one;
--    * the binding is re-pointed at the 사업장's own SITE unit (#14.1), so
--      the legacy id resolves to the 사업장. Bindings refuse UPDATE (0215),
--      so it is DELETE then INSERT, with the original binder as actor.
--    The old name-only anchor unit is left as it is: it has no kind, so it
--    is not a tree node (orgchange head.rs; entity structure.rs). Branches
--    that back no 사업장 keep their binding until a 사업장 adopts them.
--    Regions have no counterpart (the 법인 groups 사업장) and keep theirs.
--    Re-running finds the bindings already on the SITE unit: idempotent.
DO $$
DECLARE
    m RECORD;
BEGIN
    SET LOCAL row_security = off;
    FOR m IN
        SELECT w.org_id, w.id AS workplace_id, w.default_branch_id::text AS branch, b.org_unit_id AS bound,
               b.actor_id, p.org_unit_id AS site
        FROM workplaces w
        JOIN org_unit_source_bindings b
          ON b.org_id = w.org_id AND b.source_kind = 'branch' AND b.source_id = w.default_branch_id::text
        LEFT JOIN org_unit_placements p
          ON p.org_id = w.org_id AND p.workplace_id = w.id AND p.represents_workplace AND p.valid_to IS NULL
        WHERE w.voided_at IS NULL AND w.default_branch_id IS NOT NULL
    LOOP
        UPDATE workplaces SET kind_code = 'BRANCH'
        WHERE org_id = m.org_id AND id = m.workplace_id AND kind_code IS NULL;
        CONTINUE WHEN m.site IS NULL OR m.site = m.bound;
        DELETE FROM org_unit_source_bindings
        WHERE org_id = m.org_id AND source_kind = 'branch' AND source_id = m.branch;
        INSERT INTO org_unit_source_bindings (org_id, source_kind, source_id, org_unit_id, actor_id, payload_digest)
        VALUES (m.org_id, 'branch', m.branch, m.site, m.actor_id,
                sha256(convert_to(jsonb_build_object('source_kind', 'branch', 'source_id', m.branch,
                    'org_unit_id', m.site::text, 'migration', 'workplace_kinds')::text, 'UTF8')));
    END LOOP;
END $$;
