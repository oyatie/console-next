//! Finite table loops must expose every added column and its classification to both gate scans.
use console_gate_personal_data_classification::{parse_markers, parse_schema};
use std::{fs, path::PathBuf};

fn migration(body: &str, name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("pd-foreach-{}-{name}", std::process::id()));
    fs::create_dir_all(&dir)?;
    let path = dir.join("0422_loop.sql");
    fs::write(
        &path,
        format!("CREATE TABLE one(id UUID); CREATE TABLE two(id UUID); {body}"),
    )?;
    Ok(path)
}

#[test]
fn finite_literal_table_loop_exposes_columns_and_markers() -> Result<(), Box<dyn std::error::Error>>
{
    let path = migration("DO $$ DECLARE t text; BEGIN
        FOREACH t IN ARRAY ARRAY['one','two'] LOOP
            EXECUTE format('ALTER TABLE %I ADD COLUMN snapshot jsonb, ADD COLUMN started_at timestamptz', t);
            EXECUTE format('COMMENT ON COLUMN %I.snapshot IS %L', t, 'pd:personal — knowledge facts');
            EXECUTE format('COMMENT ON COLUMN %I.started_at IS %L', t, 'pd:none — tracking start');
        END LOOP;
    END $$;", "complete")?;
    let schema = parse_schema(std::slice::from_ref(&path));
    assert!(schema.unsupported.is_empty(), "{:?}", schema.unsupported);
    for table in ["one", "two"] {
        assert!(schema.tables[table].contains("snapshot"));
        assert!(schema.tables[table].contains("started_at"));
    }
    assert_eq!(parse_markers(&[path]).len(), 4);
    Ok(())
}

#[test]
fn variable_lists_conditions_and_extra_code_keep_the_ddl_refusal()
-> Result<(), Box<dyn std::error::Error>> {
    for (index, body) in [
        "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY target_tables LOOP EXECUTE format('ALTER TABLE %I ADD COLUMN raw text',t); END LOOP; END $$;",
        "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['one'] LOOP IF enabled THEN EXECUTE format('ALTER TABLE %I ADD COLUMN raw text',t); END IF; END LOOP; END $$;",
        "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['one'] LOOP EXECUTE format('ALTER TABLE %I ADD COLUMN raw text',t); END LOOP; EXECUTE 'ALTER TABLE two ADD COLUMN hidden text'; END $$;",
        "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['one'] LOOP EXECUTE format('ALTER TABLE %I ADD COLUMN raw text', other); END LOOP; END $$;",
    ].into_iter().enumerate() {
        let path = migration(body, &format!("unknown-{index}"))?;
        let schema = parse_schema(&[path]);
        assert!(!schema.unsupported.is_empty(), "{body}");
    }
    Ok(())
}

#[test]
fn finite_loop_still_reports_unclassified_columns() -> Result<(), Box<dyn std::error::Error>> {
    let path = migration(
        "DO $$ DECLARE t text; BEGIN
        FOREACH t IN ARRAY ARRAY['one','two'] LOOP
            EXECUTE format('ALTER TABLE %I ADD COLUMN snapshot jsonb', t);
        END LOOP;
    END; $$;",
        "unclassified",
    )?;
    let result = console_gate_personal_data_classification::check_files(
        &[path],
        &std::collections::BTreeSet::new(),
    );
    assert!(!result.passed());
    for table in ["one", "two"] {
        assert!(result.violations.iter().any(|v| v.kind
            == console_gate_personal_data_classification::ViolationKind::UnclassifiedColumn
            && v.detail.contains(&format!("{table}.snapshot"))));
    }
    Ok(())
}

#[test]
fn oversized_literal_table_list_keeps_the_ddl_refusal() -> Result<(), Box<dyn std::error::Error>> {
    let tables = (0..65)
        .map(|n| format!("'table_{n}'"))
        .collect::<Vec<_>>()
        .join(",");
    let path = migration(
        &format!(
            "DO $$ DECLARE t text; BEGIN
        FOREACH t IN ARRAY ARRAY[{tables}] LOOP
            EXECUTE format('ALTER TABLE %I ADD COLUMN raw text', t);
        END LOOP;
    END $$;"
        ),
        "oversized",
    )?;
    assert!(!parse_schema(&[path]).unsupported.is_empty());
    Ok(())
}

#[test]
fn directives_inside_table_names_cannot_rewrite_the_actual_ddl()
-> Result<(), Box<dyn std::error::Error>> {
    let path = migration(
        r#"CREATE TABLE "one%L"(id uuid);
        CREATE TABLE "one''"(id uuid, raw text);
        COMMENT ON COLUMN one.id IS 'pd:none — test';
        COMMENT ON COLUMN two.id IS 'pd:none — test';
        COMMENT ON COLUMN "one%L".id IS 'pd:none — test';
        COMMENT ON COLUMN "one''".id IS 'pd:none — test';
        COMMENT ON COLUMN "one''".raw IS 'pd:none — test';
        DO $$ DECLARE t text; BEGIN
            FOREACH t IN ARRAY ARRAY['one%L'] LOOP
                EXECUTE format('ALTER TABLE %I ADD COLUMN raw text', t, '');
            END LOOP;
        END $$;"#,
        "identifier-directive",
    )?;
    let result = console_gate_personal_data_classification::check_files(
        &[path],
        &std::collections::BTreeSet::new(),
    );
    assert!(
        !result.passed(),
        "SQL format directives must not consume table-name data: {result:?}"
    );
    Ok(())
}
