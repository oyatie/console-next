-- Employees reference real OrgUnits (Site / Department / Team).
--
-- `employees.org_unit` stays the legacy TEXT column every existing reader
-- uses; for rows written through the directory/lifecycle surfaces it is now the
-- bound unit's NAME, a read-only projection. The binding itself is this
-- nullable, tenant-scoped reference to the canonical `org_units` identity
-- anchor (0215). Nullable because imported/legacy rows may be unbound; the
-- composite FK keeps a binding inside its own Company (org_id is part of it).
-- Writer: `console-ontology-canonical-adapter-postgres` (ObjectKey::Employment).
ALTER TABLE employees
    ADD COLUMN org_unit_id UUID NULL;

ALTER TABLE employees
    ADD CONSTRAINT employees_org_unit_fk
    FOREIGN KEY (org_id, org_unit_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT;

CREATE INDEX employees_org_unit_id_idx
    ON employees (org_id, org_unit_id)
    WHERE org_unit_id IS NOT NULL;

-- TRANSFER / ONBOARD history keeps the unit id, not only its display name.
ALTER TABLE employee_lifecycle_events
    ADD COLUMN to_org_unit_id UUID NULL;

COMMENT ON COLUMN employees.org_unit_id IS 'pd:none — canonical OrgUnit reference, structural';
COMMENT ON COLUMN employee_lifecycle_events.to_org_unit_id IS 'pd:none — canonical OrgUnit reference, structural';
