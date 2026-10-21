#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Migration 0247 (BW-26) scrubs restricted spreadsheet columns and
//! 주민등록번호-shaped values out of rows imported before the importer stopped
//! persisting them. Applies 0001–0246, seeds the old shape, then runs 0247.
//! The second test does the same for 0249 (PII-2).

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn seed_run(pool: &PgPool, org: Uuid, entity_type: &str) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO data_import_runs \
         (id, org_id, entity_type, status, source_filename, source_format, source_sha256, \
          pay_period_start, pay_period_end) \
         VALUES ($1, $2, $3, 'PREVIEWED', 'book.xlsx', 'xlsx', repeat('a', 64), \
                 DATE '2026-06-01', DATE '2026-06-30')",
    )
    .bind(run)
    .bind(org)
    .bind(entity_type)
    .execute(pool)
    .await
    .unwrap();
    run
}

async fn seed_row(
    pool: &PgPool,
    org: Uuid,
    run: Uuid,
    raw: serde_json::Value,
    canonical: serde_json::Value,
) {
    sqlx::query(
        "INSERT INTO data_import_rows \
         (org_id, run_id, source_sheet, source_row, source_key, row_status, raw_row, canonical_row) \
         VALUES ($1, $2, 's', 2, 'row-2', 'CANDIDATE', $3, $4)",
    )
    .bind(org)
    .bind(run)
    .bind(raw)
    .bind(canonical)
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = false)]
async fn scrubs_restricted_columns_and_rrn_values_in_place(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(246, &pool).await.unwrap();

    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'BW-26 scrub')")
        .bind(org)
        .bind(format!("bw26-scrub-{}", &org.to_string()[..8]))
        .execute(&pool)
        .await
        .unwrap();
    let legacy_raw = json!({
        "성명": "홍길동",
        "소속": "본사",
        "근무지(주소)": "서울 본사",
        "주민등록번호": "900101-1234567",
        "급여": 4271953,
        "계좌": "110-987-654321",
        "전화": "010-1234-0002",
        "개인주소": "",
        "비고": "확인 8001012345678",
        "ID번호": 7501012345678_i64
    });
    let employee_run = seed_run(&pool, org, "employee_hr").await;
    seed_row(
        &pool,
        org,
        employee_run,
        legacy_raw.clone(),
        json!({
            "source_key": "row-2",
            "name": "홍길동",
            "source_metadata": { "filename": "book.xlsx" },
            "canonical": { "employee_number": "900101-1234567", "org_unit": "본사" }
        }),
    )
    .await;
    let attendance_run = seed_run(&pool, org, "attendance_direct").await;
    seed_row(
        &pool,
        org,
        attendance_run,
        json!({ "사번": "E-1", "지점": "본사", "주소": "서울", "연락처": "010-5555-6666", "메모": "6602021234567" }),
        json!({ "canonical": { "employee_number": "E-1" } }),
    )
    .await;
    let employee: (Uuid, time::OffsetDateTime) = sqlx::query_as(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, \
                                source_key, raw_row, source_metadata) \
         VALUES ($1, 'SAE', '홍길동', 'book.xlsx', 's', 2, 'row-2', $2, $3) \
         RETURNING id, updated_at",
    )
    .bind(org)
    .bind(&legacy_raw)
    .bind(json!({ "filename": "book.xlsx", "note": "900101-1234567" }))
    .fetch_one(&pool)
    .await
    .unwrap();

    migrator.run(&pool).await.unwrap();

    let rows: Vec<(String, serde_json::Value, serde_json::Value)> = sqlx::query_as(
        "SELECT run.entity_type, r.raw_row, r.canonical_row FROM data_import_rows r \
         JOIN data_import_runs run ON run.id = r.run_id ORDER BY run.entity_type",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows.len(),
        2,
        "the scrub updates; it inserts and deletes nothing"
    );
    let (_, attendance_raw, attendance_canonical) = &rows[0];
    assert_eq!(attendance_raw, &json!({ "사번": "E-1", "지점": "본사" }));
    assert_eq!(
        attendance_canonical,
        &json!({ "canonical": { "employee_number": "E-1" } })
    );

    let (_, employee_raw, employee_canonical) = &rows[1];
    let kept = json!({ "성명": "홍길동", "소속": "본사", "근무지(주소)": "서울 본사" });
    assert_eq!(employee_raw, &kept);
    assert_eq!(
        employee_canonical["canonical"],
        json!({ "org_unit": "본사" })
    );
    let mut dropped: Vec<String> = serde_json::from_value(
        employee_canonical["source_metadata"]["dropped_restricted_columns"].clone(),
    )
    .unwrap();
    dropped.sort();
    let mut expected = ["주민등록번호", "급여", "계좌", "전화", "비고", "ID번호"].map(String::from);
    expected.sort();
    assert_eq!(dropped, expected, "blank 개인주소 is dropped but not named");

    let (raw, metadata, updated_at): (serde_json::Value, serde_json::Value, time::OffsetDateTime) =
        sqlx::query_as("SELECT raw_row, source_metadata, updated_at FROM employees WHERE id = $1")
            .bind(employee.0)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(raw, kept);
    assert_eq!(metadata, json!({ "filename": "book.xlsx" }));
    assert_eq!(updated_at, employee.1, "a scrub is not an edit");

    let still_append_only = sqlx::query("UPDATE data_import_rows SET raw_row = '{}'")
        .execute(&pool)
        .await;
    assert!(
        still_append_only.is_err(),
        "0247 must re-enable the append-only trigger"
    );
    let helpers: i64 =
        sqlx::query_scalar("SELECT count(*) FROM pg_proc WHERE proname LIKE 'bw26_%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(helpers, 0, "the scrub helpers are dropped");
}

/// Migration 0249 (PII-2) scrubs what 0247 missed: stripped-zero RRN keys and
/// values, the PII-2 headers (a bare 주소 too, with the worksite address copied
/// from it), and RRNs in lineage text, which become one salted token per RRN.
#[sqlx::test(migrations = false)]
async fn pii2_scrubs_stripped_zero_rrns_pii2_headers_and_lineage_text(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(248, &pool).await.unwrap();

    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'PII-2 scrub')")
        .bind(org)
        .bind(format!("pii2-scrub-{}", &org.to_string()[..8]))
        .execute(&pool)
        .await
        .unwrap();
    // 301014123456 is 030101-4123456 with Excel's leading zero dropped;
    // 10101345678 has a 1900s gender digit, so it is a long 사번 and stays.
    let raw = json!({
        "성명": "김철수",
        "사번": "10101345678",
        "근무지(주소)": "부산 지점",
        "주소": "서울 집",
        "Bank Account": "110-987",
        "생년월일": "2003-01-01",
        "301014123456": "x",
        "비고": 301014123456_i64
    });
    let kept = json!({ "성명": "김철수", "사번": "10101345678", "근무지(주소)": "부산 지점" });
    let run = seed_run(&pool, org, "employee_hr").await;
    sqlx::query(
        "INSERT INTO data_import_rows \
         (org_id, run_id, source_sheet, source_row, source_key, row_status, raw_row, canonical_row) \
         VALUES ($1, $2, '900101-1234567 명단', 2, 'row-2', 'CANDIDATE', $3, $4)",
    )
    .bind(org)
    .bind(run)
    .bind(&raw)
    .bind(json!({ "canonical": { "worksite_address": "서울 집", "org_unit": "본사" } }))
    .execute(&pool)
    .await
    .unwrap();
    let employee: (Uuid, time::OffsetDateTime) = sqlx::query_as(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, \
                                source_key, raw_row, source_metadata, worksite_address) \
         VALUES ($1, '900101-1234567', '김철수', 'book.xlsx', 's', 2, 'row-2', $2, '{}', '서울 집') \
         RETURNING id, updated_at",
    )
    .bind(org)
    .bind(&raw)
    .fetch_one(&pool)
    .await
    .unwrap();

    migrator.run(&pool).await.unwrap();

    let (row_raw, canonical, sheet): (serde_json::Value, serde_json::Value, String) =
        sqlx::query_as("SELECT raw_row, canonical_row, source_sheet FROM data_import_rows")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row_raw, kept);
    assert_eq!(
        canonical,
        json!({ "canonical": { "worksite_address": null, "org_unit": "본사" } }),
        "a worksite address copied from a bare 주소 is cleared"
    );
    let token = sheet.strip_suffix(" 명단").unwrap();
    assert!(token.starts_with("rrn-") && token.len() == 16, "{sheet}");

    let (emp_raw, company, worksite, updated_at): (
        serde_json::Value,
        String,
        Option<String>,
        time::OffsetDateTime,
    ) = sqlx::query_as(
        "SELECT raw_row, company, worksite_address, updated_at FROM employees WHERE id = $1",
    )
    .bind(employee.0)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(emp_raw, kept);
    assert_eq!(company, token, "one RRN maps to one token across tables");
    assert_eq!(worksite, None);
    assert_eq!(updated_at, employee.1, "a scrub is not an edit");

    let still_append_only = sqlx::query("UPDATE data_import_rows SET raw_row = '{}'")
        .execute(&pool)
        .await;
    assert!(
        still_append_only.is_err(),
        "0249 must re-enable the trigger"
    );
    let helpers: i64 =
        sqlx::query_scalar("SELECT count(*) FROM pg_proc WHERE proname LIKE 'pii2_%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(helpers, 0, "the scrub helpers are dropped");
}
