//! BW-10: identity by 사번, no status overwrite, the digest-bound apply.

use console_hr_domain::import::plan::Decisions;
use sqlx::PgPool;

use crate::import_fixture::{importer, line};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reupload_with_rows_inserted_mid_sheet_swaps_nobody(pool: PgPool) {
    let im = importer(pool).await;
    let first = im
        .load("명부.xlsx", &[line("E-1", "김일"), line("E-2", "이이")])
        .await;
    assert_eq!((first.inserted, first.updated), (2, 0));
    let (kim, ..) = im.person("E-1").await;

    // The same file again, a new person typed above them: every position moved.
    let run = im
        .preview(
            "명부.xlsx",
            &[
                line("E-9", "박새"),
                line("E-1", "김일"),
                line("E-2", "이이"),
            ],
        )
        .await;
    let plan = im.dry_run(run, Decisions::default()).await;
    let outcomes: Vec<_> = plan.rows.iter().map(|r| r.outcome).collect();
    assert_eq!(outcomes, ["insert", "unchanged", "unchanged"]);
    assert_eq!(
        plan.rows[1].employee_id,
        Some(kim),
        "the dry run names the 사번 holder"
    );
    let second = im.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!((second.inserted, second.updated, second.skipped), (1, 0, 2));
    let (still, name, ..) = im.person("E-1").await;
    assert_eq!((still, name.as_str()), (kim, "김일"));

    // The legacy one-shot route answers 410 (BW-10 8).
    assert_eq!(im.f.hr.import_workbook_gone().status.as_u16(), 410);
    // A replay of the APPLIED run returns the stored report and writes nothing.
    let replay = im.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!((replay.inserted, replay.skipped), (1, 2));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_import_never_moves_status_or_exits_anyone(pool: PgPool) {
    let im = importer(pool.clone()).await;
    im.load("명부.xlsx", &[line("E-1", "김일")]).await;
    let (id, ..) = im.person("E-1").await;
    sqlx::query("UPDATE employees SET employment_status = 'ON_LEAVE' WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let mut promoted = line("E-1", "김일");
    promoted.position = Some("대리");
    promoted.exit = Some("2026-09-30");
    let run = im.preview("명부.xlsx", &[promoted]).await;
    let plan = im.dry_run(run, Decisions::default()).await;
    assert_eq!(plan.rows[0].outcome, "update");
    assert_eq!(plan.rows[0].deferred[0].route, "exit_case");
    im.apply(run, &plan.dry_run_digest).await.unwrap();
    let (_, _, status, position, exit) = im.person("E-1").await;
    assert_eq!(
        (status.as_str(), position.as_deref(), exit),
        ("ON_LEAVE", Some("대리"), None)
    );
    let before: serde_json::Value = sqlx::query_scalar(
        "SELECT before FROM import_run_row_snapshots WHERE run_id = $1 AND employee_id = $2",
    )
    .bind(run)
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before["position"], "사원");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_is_bound_to_the_dry_run_the_operator_saw(pool: PgPool) {
    let im = importer(pool.clone()).await;
    im.load("명부.xlsx", &[line("E-1", "김일")]).await;
    let mut promoted = line("E-1", "김일");
    promoted.position = Some("대리");
    let run = im.preview("명부.xlsx", &[promoted]).await;
    let plan = im.dry_run(run, Decisions::default()).await;

    let stale = im.apply(run, &"0".repeat(64)).await.unwrap_err();
    assert_eq!(
        (stale.status.as_u16(), stale.code),
        (409, "dry_run_digest_mismatch")
    );

    // Someone edits the person after the dry run.
    sqlx::query(
        "UPDATE employees SET job = '회계', updated_at = now() WHERE employee_number = 'E-1'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let moved = im.apply(run, &plan.dry_run_digest).await.unwrap_err();
    assert_eq!(
        (moved.status.as_u16(), moved.code),
        (409, "rows_changed_since_preview")
    );
    assert_eq!(
        moved.refusals.unwrap()[0]["source_key"],
        plan.rows[0].source_key
    );
    let status: String = sqlx::query_scalar("SELECT status FROM data_import_runs WHERE id = $1")
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "DRY_RUN");
}
