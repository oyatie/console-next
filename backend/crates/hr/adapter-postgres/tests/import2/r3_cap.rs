//! UX-R3 IMPORT r3:hire-17: `import.apply.max_rows` counts current people;
//! a 퇴사자 sheet comes in the same run apart from the cap.

use console_hr_domain::import::detect::WorkbookMappingRequest;
use sqlx::PgPool;

use crate::harness::{Importer, decisions, importer, table};

async fn cap(i: &Importer, max: i64) {
    sqlx::query(
        "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
         VALUES ($1, 'import.apply.max_rows', to_jsonb($3::BIGINT), $2, 'TEST')",
    )
    .bind(i.org())
    .bind(*i.f.principal.user_id.as_uuid())
    .bind(max)
    .execute(&i.owner)
    .await
    .unwrap();
}

fn sheet(head: &[&str], body: &[Vec<String>]) -> Vec<Vec<String>> {
    std::iter::once(head.iter().map(|h| (*h).to_owned()).collect())
        .chain(body.iter().cloned())
        .collect()
}

fn view(rows: &[Vec<String>]) -> Vec<Vec<&str>> {
    rows.iter()
        .map(|r| r.iter().map(String::as_str).collect())
        .collect()
}

/// `current` people on 「재직자」 and `former` on 「퇴사자」 (a 퇴사일 each).
async fn run(i: &Importer, current: usize, former: usize) -> uuid::Uuid {
    let staff: Vec<Vec<String>> = (0..current)
        .map(|n| vec![format!("E-{n}"), format!("직원{n}"), "2024-03-04".into()])
        .collect();
    let left: Vec<Vec<String>> = (0..former)
        .map(|n| {
            vec![
                format!("X-{n}"),
                format!("퇴직{n}"),
                "2015-03-02".into(),
                "2025-01-28".into(),
            ]
        })
        .collect();
    let staff = sheet(&["사번", "성명", "입사일"], &staff);
    let left = sheet(&["사번", "성명", "입사일", "퇴사일"], &left);
    let (staff, left) = (view(&staff), view(&left));
    let staff: Vec<&[&str]> = staff.iter().map(Vec::as_slice).collect();
    let left: Vec<&[&str]> = left.iter().map(Vec::as_slice).collect();
    i.preview(
        "명부.xlsx",
        &[table("재직자", 0, &staff), table("퇴사자", 0, &left)],
        &WorkbookMappingRequest::default(),
    )
    .await
    .unwrap()
    .run_id
}

/// regression (r3:hire-17): 100 current people and a 퇴사자 sheet under a
/// cap of 100 were refused as 103 rows; the only way through
/// was to skip the 퇴사자 sheet.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_former_employees_do_not_count_against_the_row_cap(pool: PgPool) {
    let i = importer(pool).await;
    cap(&i, 100).await;
    let run = run(&i, 100, 3).await;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.candidate_rows, 103);
    let report = i.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!(
        report.inserted, 103,
        "staff and former employees in one pass"
    );
}

/// The cap still holds for current people: 101 over a cap of 100 is 422
/// `import_row_limit` naming 101 rows (the 퇴사자 apart), nothing stored.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn current_people_over_the_cap_are_still_refused(pool: PgPool) {
    let i = importer(pool).await;
    cap(&i, 100).await;
    let run = run(&i, 101, 3).await;
    let refused = i.try_dry_run(run, decisions()).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "import_row_limit")
    );
    let named = refused.refusals.unwrap();
    assert_eq!(
        (named[0]["max"].clone(), named[0]["rows"].clone()),
        (100.into(), 101.into())
    );
    let status: String = sqlx::query_scalar("SELECT status FROM data_import_runs WHERE id = $1")
        .bind(run)
        .fetch_one(&i.owner)
        .await
        .unwrap();
    assert_eq!(status, "PREVIEWED");
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        0
    );
}
