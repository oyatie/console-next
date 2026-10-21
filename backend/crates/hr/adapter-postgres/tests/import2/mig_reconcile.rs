//! BE-MIG W11 × BE-EMP-UI 이관 확인: reconcile opens only once the apply job
//! is done.

use sqlx::PgPool;

use crate::harness::importer;
use crate::mig_job::staged;

/// 이관 확인 reads the run's people: while its job still settles (the run is
/// APPLIED before they are placed) it is 409 `apply_in_progress`, never a
/// half-settled count; once the job is done it opens.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reconcile_waits_for_the_apply_job(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 2).await;
    assert_eq!(i.apply(run, &digest).await.unwrap().inserted, 2);
    sqlx::query(
        "UPDATE data_import_runs SET apply_job = jsonb_set(apply_job, '{state}', '\"settling\"') \
         WHERE id = $1",
    )
    .bind(run)
    .execute(&i.owner)
    .await
    .unwrap();
    let refused =
        i.f.hr
            .import_reconcile(i.f.principal.clone(), run)
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "apply_in_progress")
    );
    sqlx::query(
        "UPDATE data_import_runs SET apply_job = jsonb_set(apply_job, '{state}', '\"done\"') \
         WHERE id = $1",
    )
    .bind(run)
    .execute(&i.owner)
    .await
    .unwrap();
    assert!(
        i.f.hr
            .import_reconcile(i.f.principal.clone(), run)
            .await
            .is_ok()
    );
}
