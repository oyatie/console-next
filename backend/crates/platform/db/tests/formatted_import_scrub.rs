// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Historical import cleanup preserves unrelated data and rollback-safe structure.
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = false)]
async fn formatted_values_are_scrubbed_atomically_and_idempotently(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(20261105010000000, &pool).await.unwrap();
    let org = Uuid::new_v4();
    let key = "filename:９００１０１－１２３４５６７.xlsx|row:2";
    let decisions = json!({
        "exclusions": {key: {"reason_code": "DUPLICATE", "note": "900101 1234567"}},
        "employee_numbers": {key: "2026000123"}
    });
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Import cleanup')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE data_import_runs DISABLE TRIGGER trg_data_import_runs_employee_hr_command_only")
        .execute(&pool).await.unwrap();
    let run: Uuid = sqlx::query_scalar("INSERT INTO data_import_runs (org_id, entity_type, status, source_filename, source_format, source_sha256, mapping_profile, dry_run_summary, apply_summary, apply_job, rollback_job, dry_run_decisions) VALUES ($1, 'employee_hr', 'PREVIEWED', $2, 'xlsx', repeat('a',64), $3, $4, $3, $3, $3, $5) RETURNING id")
        .bind(org).bind("９００１０１－１２３４５６７.xlsx")
        .bind(json!({"company":"900101 1234567", "keep":"본사"}))
        .bind(json!({"company":"900101 1234567", "keep":"본사", "decisions":decisions})).bind(decisions)
        .fetch_one(&pool).await.unwrap();
    sqlx::query(
        "ALTER TABLE data_import_runs ENABLE TRIGGER trg_data_import_runs_employee_hr_command_only",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut cells = json!({"keep": "본사", "number": "2026000123", "reference": "9013011-234567", "century_reference": "0002291-234567", "spaced_reference": "901 3011234567", "nested": [{"keep": true}]});
    let digits = "9001011234567";
    for at in 0..=digits.len() {
        cells[format!("mapped_{at}")] = json!(format!("{}-{}", &digits[..at], &digits[at..]));
    }
    for (at, text) in [
        "900101 1234567",
        "900101–1234567",
        "９００１０１－１２３４５６７",
        "9001011234567.0",
        "５０１０１３２３４５６７.0",
        "５０１０１３２３４５６７．０",
        "확인 900101-1234567",
        "1 900101-1234567 2",
        "1 900101 1234567 2",
        "1 ９００１０１－１２３４５６７ 2",
        "0002293-234567",
    ]
    .iter()
    .enumerate()
    {
        cells[format!("formatted_{at}")] = json!(text);
    }
    let row: (Uuid, time::OffsetDateTime) = sqlx::query_as("INSERT INTO data_import_rows (org_id, run_id, source_sheet, source_row, source_key, row_status, raw_row, canonical_row) VALUES ($1,$2,'명부',2,$3,'CANDIDATE',$4,$5) RETURNING id, created_at")
        .bind(org).bind(run).bind(key).bind(&cells)
        .bind(json!({"name":"김가", "source_key":key, "source_filename":"people.xlsx", "source_sheet":"명부", "source_row":2, "canonical":cells}))
        .fetch_one(&pool).await.unwrap();
    let employee: (Uuid, time::OffsetDateTime) = sqlx::query_as("INSERT INTO employees (org_id, name, company, source_filename, source_sheet, source_row, source_key, raw_row, source_metadata, job, position, org_unit) VALUES ($1,'김가','900101 1234567','people.xlsx','명부',2,$2,$3,$3,'900101–1234567','９００１０１－１２３４５６７','본사') RETURNING id, updated_at")
        .bind(org).bind(key).bind(&cells).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO import_run_row_snapshots (org_id,run_id,employee_id,source_key,outcome,before) VALUES ($1,$2,$3,$4,'UPDATED',$5)")
        .bind(org).bind(run).bind(employee.0).bind(key).bind(json!({"job":"900101 1234567", "org_unit":"본사"})).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO data_import_row_phones (org_id,run_id,source_key,phone_e164) VALUES ($1,$2,$3,'+821012345678')")
        .bind(org).bind(run).bind(key).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO data_import_row_identities (org_id,run_id,source_key,rrn_hmac,hmac_key_version,ciphertext,nonce,dek_wrapped,dek_nonce,key_version,masked) VALUES ($1,$2,$3,decode(repeat('ab',32),'hex'),1,decode(repeat('ab',16),'hex'),decode(repeat('ab',24),'hex'),decode(repeat('ab',16),'hex'),decode(repeat('ab',24),'hex'),1,'900101-1******')")
        .bind(org).bind(run).bind(key).execute(&pool).await.unwrap();
    let actor: Uuid = sqlx::query_scalar(
        "INSERT INTO users (org_id,display_name) VALUES ($1,'Import reviewer') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    for (attributes, receipt) in [
        (json!({"legacy":"900101 1234567"}), json!({})),
        (json!({}), json!({"legacy":"９００１０１－１２３４５６７"})),
        (
            json!({"legacy":"900101–1234567"}),
            json!({"legacy":"9001011234567.0"}),
        ),
    ] {
        let person: Uuid =
            sqlx::query_scalar("INSERT INTO persons (org_id) VALUES ($1) RETURNING id")
                .bind(org)
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query("INSERT INTO person_revisions (org_id,person_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,1,$3,$4,decode(repeat('ab',32),'hex'),$5,$6)")
            .bind(org).bind(person).bind(Uuid::new_v4()).bind(actor).bind(attributes).bind(receipt)
            .execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO person_binding_reviews (org_id,subject_kind,subject_id,reason,evidence) VALUES ($1,'EMPLOYEE',$2,'NUMBER_BIRTH_AMBIGUOUS',$3)")
        .bind(org).bind(employee.0).bind(json!({"legacy":"９００１０１－１２３４５６７"}))
        .execute(&pool).await.unwrap();
    let history: Value = sqlx::query_scalar("SELECT jsonb_build_object('revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM person_revisions r),'reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY subject_id) FROM person_binding_reviews r))")
        .fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO import_reconcile_checks (org_id,run_id,source_key,state,note,checked_by) VALUES ($1,$2,$3,'NEEDS_CHECK','확인 필요',$4)")
        .bind(org).bind(run).bind(key).bind(actor).execute(&pool).await.unwrap();
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (org_id,name) VALUES ($1,'서울') RETURNING id")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    let branch: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (org_id,region_id,name) VALUES ($1,$2,'본사') RETURNING id",
    )
    .bind(org)
    .bind(region)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO attendance_direct_import_events (org_id,run_id,import_row_id,employee_id,branch_id,source_sheet,source_row,source_key,source_sha256,fact_key,employee_number,employee_name,branch_name,work_date,minutes_worked) VALUES ($1,$2,$3,$4,$5,'900101–1234567',2,$6,repeat('a',64),'attendance:2','900101 1234567','９００１０１－１２３４５６７','9001011234567.0','2026-01-02',480)")
        .bind(org).bind(run).bind(row.0).bind(employee.0).bind(branch).bind(key)
        .execute(&pool).await.unwrap();
    let before = read_rows(&pool).await;
    if let Some(migration) = migrator.iter().find(|m| m.version == 20261106000000000) {
        let mut tx = pool.begin().await.unwrap();
        let interrupted = format!("{}; SELECT 1 / 0;", migration.sql.as_ref());
        let error = sqlx::raw_sql(sqlx::AssertSqlSafe(interrupted))
            .execute(&mut *tx)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("22012"),
            "cleanup completes before the injected failure"
        );
        tx.rollback().await.unwrap();
        assert_eq!(
            read_rows(&pool).await,
            before,
            "failure leaves no partial scrub"
        );
        assert!(
            sqlx::query("UPDATE data_import_rows SET raw_row='{}'")
                .execute(&pool)
                .await
                .is_err()
        );
    }
    let migration = migrator
        .iter()
        .find(|m| m.version == 20261106000000000)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    let count_probe = migration.sql.as_ref().replace(
        "RAISE NOTICE 'import scrub:",
        "RAISE EXCEPTION 'import scrub:",
    );
    let error = sqlx::raw_sql(sqlx::AssertSqlSafe(count_probe))
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().message(),
        "import scrub: 3 person_revisions and 1 person_binding_reviews rows hold restricted plaintext; owner decision needed"
    );
    tx.rollback().await.unwrap();
    migrator.run(&pool).await.unwrap();
    let retained_history: Value = sqlx::query_scalar("SELECT jsonb_build_object('revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM person_revisions r),'reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY subject_id) FROM person_binding_reviews r))")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(
        retained_history, history,
        "immutable history is only counted"
    );
    let snapshot = read_rows(&pool).await;
    let (raw, canonical, stored_key, created): (Value, Value, String, time::OffsetDateTime) =
        sqlx::query_as(
            "SELECT raw_row,canonical_row,source_key,created_at FROM data_import_rows WHERE id=$1",
        )
        .bind(row.0)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        raw,
        json!({"keep":"본사", "number":"2026000123", "reference":"9013011-234567", "century_reference":"0002291-234567", "spaced_reference":"901 3011234567", "nested":[{"keep":true}]})
    );
    assert_eq!(canonical["canonical"]["keep"], "본사");
    assert_eq!(canonical["name"], "김가");
    assert_eq!(canonical["source_key"], stored_key);
    assert_eq!(created, row.1);
    let (emp_key, org_unit, updated): (String, String, time::OffsetDateTime) =
        sqlx::query_as("SELECT source_key, org_unit, updated_at FROM employees WHERE id=$1")
            .bind(employee.0)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(emp_key, stored_key, "lineage joins survive cleanup");
    let phone: (String, String) =
        sqlx::query_as("SELECT source_key,phone_e164 FROM data_import_row_phones WHERE run_id=$1")
            .bind(run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(phone, (stored_key.clone(), "+821012345678".into()));
    assert_eq!(org_unit, "본사");
    assert_eq!(updated, employee.1);
    let stored_run = &snapshot["runs"][0];
    assert!(
        stored_run["source_filename"]
            .as_str()
            .unwrap()
            .starts_with("redacted-")
    );
    assert_eq!(stored_run["status"], "PREVIEWED");
    let decisions = &stored_run["dry_run_decisions"];
    assert_eq!(decisions, &stored_run["dry_run_summary"]["decisions"]);
    assert_eq!(
        decisions,
        &json!({"exclusions": {stored_key.clone(): {"reason_code": "DUPLICATE", "note": stored_run["mapping_profile"]["company"]}}, "employee_numbers": {stored_key.clone(): "2026000123"}})
    );
    for column in [
        "mapping_profile",
        "dry_run_summary",
        "apply_summary",
        "apply_job",
        "rollback_job",
    ] {
        assert_eq!(stored_run[column]["keep"], "본사");
        assert!(
            stored_run[column]["company"]
                .as_str()
                .unwrap()
                .starts_with("redacted-")
        );
    }
    for table in ["identities", "reconcile", "attendance"] {
        let entry = &snapshot[table][0];
        assert_eq!(entry["source_key"], stored_key);
        let original = &before[table][0];
        for (column, value) in original.as_object().unwrap() {
            if column == "source_key"
                || (table == "attendance"
                    && [
                        "source_sheet",
                        "employee_number",
                        "employee_name",
                        "branch_name",
                    ]
                    .contains(&column.as_str()))
            {
                assert!(entry[column].as_str().unwrap().starts_with("redacted-"));
            } else {
                assert_eq!(
                    &entry[column], value,
                    "unrelated {table}.{column} is preserved"
                );
            }
        }
    }
    let rollback: (String, Value) =
        sqlx::query_as("SELECT source_key, before FROM import_run_row_snapshots WHERE run_id=$1")
            .bind(run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rollback.0, stored_key);
    assert_eq!(rollback.1["org_unit"], "본사");
    assert!(rollback.1["job"].as_str().unwrap().starts_with("redacted-"));
    for (_, value) in cells
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| key.starts_with("mapped_") || key.starts_with("formatted_"))
    {
        assert!(
            !snapshot.to_string().contains(value.as_str().unwrap()),
            "restricted cell survived cleanup"
        );
    }
    // Replaying the SQL is stronger than SQLx's already-applied migration check.
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(migration.sql.as_ref()))
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(read_rows(&pool).await, snapshot);
    assert!(
        sqlx::query("UPDATE data_import_rows SET raw_row='{}'")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM data_import_rows")
            .execute(&pool)
            .await
            .is_err()
    );
}

async fn read_rows(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object('rows',(SELECT jsonb_agg(to_jsonb(r)) FROM data_import_rows r),'runs',(SELECT jsonb_agg(to_jsonb(r)) FROM data_import_runs r),'employees',(SELECT jsonb_agg(to_jsonb(e)) FROM employees e),'snapshots',(SELECT jsonb_agg(to_jsonb(s)) FROM import_run_row_snapshots s),'phones',(SELECT jsonb_agg(to_jsonb(p)) FROM data_import_row_phones p),'identities',(SELECT jsonb_agg(to_jsonb(i)) FROM data_import_row_identities i),'reconcile',(SELECT jsonb_agg(to_jsonb(c)) FROM import_reconcile_checks c),'attendance',(SELECT jsonb_agg(to_jsonb(a)) FROM attendance_direct_import_events a))")
        .fetch_one(pool).await.unwrap()
}
