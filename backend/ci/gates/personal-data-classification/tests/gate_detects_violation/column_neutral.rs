// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{ViolationKind, check_tree, empty_baseline, tree};

#[test]
fn gate_accepts_the_column_neutral_statements_the_repo_writes()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "column-neutral",
        "CREATE TABLE staff (id UUID PRIMARY KEY, org_id UUID NOT NULL);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';
         COMMENT ON COLUMN staff.org_id IS 'pd:none — tenant key, not a person';
         CREATE SCHEMA hr AUTHORIZATION console_app;
         CREATE EXTENSION IF NOT EXISTS pg_trgm;
         CREATE UNIQUE INDEX staff_org_idx ON staff (org_id, id);
         CREATE INDEX CONCURRENTLY staff_org ON staff (org_id);
         CREATE POLICY org_isolation ON staff USING (true);
         CREATE OR REPLACE FUNCTION hr.touch() RETURNS TRIGGER LANGUAGE plpgsql AS $$
         BEGIN RETURN NEW; END; $$;
         CREATE TRIGGER staff_touch BEFORE UPDATE ON staff
             FOR EACH ROW EXECUTE FUNCTION hr.touch();
         CREATE VIEW staff_public AS SELECT id FROM staff;
         ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
         ALTER TABLE staff FORCE ROW LEVEL SECURITY;
         ALTER TABLE staff ADD CONSTRAINT staff_org_check CHECK (org_id IS NOT NULL);
         ALTER TABLE staff VALIDATE CONSTRAINT staff_org_check;
         ALTER TABLE staff ALTER COLUMN org_id SET NOT NULL;
         ALTER TABLE staff OWNER TO console_app;
         ALTER TABLE staff RENAME CONSTRAINT staff_org_check TO staff_org_required;
         ALTER TABLE staff DROP CONSTRAINT staff_org_required;
         LOCK TABLE public.staff IN SHARE ROW EXCLUSIVE MODE;
         SET LOCAL lock_timeout = '2s';
         SET CONSTRAINTS trg_command_outcome_emit IMMEDIATE;
         SET CONSTRAINTS public.first_check, second_check DEFERRED;
         SET CONSTRAINTS ALL IMMEDIATE;
         GRANT SELECT ON staff TO console_rt;
         REVOKE ALL ON staff FROM PUBLIC;
         INSERT INTO staff (id, org_id) VALUES (gen_random_uuid(), gen_random_uuid());
         UPDATE staff SET org_id = org_id;
         WITH ordered AS (SELECT id FROM staff) UPDATE staff SET org_id = org_id;
         SELECT pg_advisory_xact_lock(hashtext('x'));",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result.passed(),
        "the corpus's column-neutral forms must stay recognised, got {:#?}",
        result.violations
    );
    assert_eq!(result.total_tables, 1, "only `staff` is a table");
    Ok(())
}

#[test]
fn gate_rejects_other_lock_and_setting_heads() -> Result<(), Box<dyn std::error::Error>> {
    for (name, sql) in [
        (
            "incomplete-constraint-rename",
            "CREATE TABLE staff(id uuid); ALTER TABLE staff RENAME CONSTRAINT check_id TO;",
        ),
        (
            "column-rename",
            "CREATE TABLE staff(id uuid); ALTER TABLE staff RENAME COLUMN id TO new_id;",
        ),
        (
            "table-rename",
            "CREATE TABLE staff(id uuid); ALTER TABLE staff RENAME TO people;",
        ),
        ("invalid-timing", "SET CONSTRAINTS staff_check DISABLED;"),
        ("missing-constraint", "SET CONSTRAINTS IMMEDIATE;"),
        (
            "trailing-token",
            "SET CONSTRAINTS staff_check IMMEDIATE extra;",
        ),
        ("unlisted-lock", "LOCK VIEW staff;"),
        ("unlisted-setting", "SET LOCAL search_path = public;"),
    ] {
        let dir = tree(name, sql)?;
        let result = check_tree(&dir, &empty_baseline())?;
        assert!(
            result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::UnsupportedDdl),
            "{name} must remain unsupported, got {:#?}",
            result.violations
        );
    }
    Ok(())
}
