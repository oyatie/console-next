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
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Import cleanup')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let run: Uuid = sqlx::query_scalar("INSERT INTO data_import_runs (org_id, entity_type, status, source_filename, source_format, source_sha256) VALUES ($1, 'employee_hr', 'PREVIEWED', 'people.xlsx', 'xlsx', repeat('a',64)) RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
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
    let key = "filename:９００１０１－１２３４５６７.xlsx|row:2";
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
    let before = read_rows(&pool).await;
    if let Some(migration) = migrator.iter().find(|m| m.version == 20261106000000000) {
        let mut tx = pool.begin().await.unwrap();
        let interrupted = format!("{}; SELECT 1 / 0;", migration.sql.as_ref());
        assert!(
            sqlx::raw_sql(sqlx::AssertSqlSafe(interrupted))
                .execute(&mut *tx)
                .await
                .is_err()
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
    migrator.run(&pool).await.unwrap();
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
    let migration = migrator
        .iter()
        .find(|m| m.version == 20261106000000000)
        .unwrap();
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
    sqlx::query_scalar("SELECT jsonb_build_object('rows',(SELECT jsonb_agg(to_jsonb(r)) FROM data_import_rows r),'employees',(SELECT jsonb_agg(to_jsonb(e)) FROM employees e),'snapshots',(SELECT jsonb_agg(to_jsonb(s)) FROM import_run_row_snapshots s),'phones',(SELECT jsonb_agg(to_jsonb(p)) FROM data_import_row_phones p))")
        .fetch_one(pool).await.unwrap()
}
