//! BE-MIG W11 (decisions #27, #28): the apply as a job — refusals stay
//! synchronous, progress is one audited event per settle chunk, a second
//! request is idempotent, a dead driver is failed (before the write) or
//! resumed (after it), and a run over `import.apply.max_rows` is refused.

use console_hr_adapter_postgres::import::apply_drive::Started;
use console_hr_adapter_postgres::import::types::EmployeeImportApplyRequest;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use sqlx::PgPool;
use uuid::Uuid;

use crate::harness::{Importer, decisions, importer, table};

pub(crate) async fn staged(i: &Importer, people: usize) -> (Uuid, String) {
    let numbers: Vec<String> = (0..people).map(|n| format!("E-{n:04}")).collect();
    let names: Vec<String> = (0..people).map(|n| format!("직원{n:04}")).collect();
    let mut rows: Vec<Vec<&str>> = vec![vec!["사번", "성명", "입사일", "고용형태"]];
    for n in 0..people {
        rows.push(vec![&numbers[n], &names[n], "2024-03-04", "정규직"]);
    }
    let rows: Vec<&[&str]> = rows.iter().map(Vec::as_slice).collect();
    let run = i
        .preview(
            "big.xlsx",
            &[table("명부", 0, &rows)],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    (run, plan.dry_run_digest)
}

fn body(digest: &str) -> EmployeeImportApplyRequest {
    EmployeeImportApplyRequest {
        dry_run_digest: digest.into(),
    }
}

async fn progress_events(i: &Importer, run: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND target_type = 'data_import_run' \
           AND target_id = $2 AND action = 'data_import.apply.progress'",
    )
    .bind(i.org())
    .bind(run.to_string())
    .fetch_one(&i.owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_apply_job_settles_in_chunks_with_one_event_each(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 130).await;
    let started =
        i.f.hr
            .start_apply(i.f.principal.clone(), run, body(&digest))
            .await
            .unwrap();
    let Started::Job(job) = started else {
        panic!("a new apply is a job: {started:?}")
    };
    assert_eq!((job.state.as_str(), job.done), ("queued", 0));
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        0,
        "202 before any write"
    );

    let org = i.f.principal.org_id;
    let report =
        i.f.hr
            .drive_apply(Some(i.store.clone()), org, run)
            .await
            .unwrap();
    assert_eq!(report.inserted, 130);
    let job = i.f.hr.apply_job(org, run).await.unwrap();
    assert_eq!(
        (job.state.as_str(), job.done, job.total),
        ("done", 130, 130)
    );
    assert_eq!(job.report.unwrap().inserted, 130);
    // queued, applying, two settle chunks (100 + 30); the second stores the
    // job done in its own transaction (r3:hire-02).
    assert_eq!(progress_events(&i, run).await, 4);
    assert_eq!(
        i.count("SELECT count(*) FROM employee_employment_profiles WHERE org_id = $1")
            .await,
        130
    );

    let again =
        i.f.hr
            .start_apply(i.f.principal.clone(), run, body(&digest))
            .await
            .unwrap();
    assert!(
        matches!(again, Started::Done(ref r) if r.inserted == 130),
        "{again:?}"
    );
    assert_eq!(progress_events(&i, run).await, 4, "a replay writes nothing");
}

/// Guards while a job runs: a dry run (409, the stored plan untouched), an
/// apply naming another digest (409), the same apply again (the job itself).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_running_job_refuses_a_dry_run_and_another_digest(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 2).await;
    i.f.hr
        .start_apply(i.f.principal.clone(), run, body(&digest))
        .await
        .unwrap();

    let refused = i.try_dry_run(run, decisions()).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "apply_in_progress")
    );
    let stored: String =
        sqlx::query_scalar("SELECT dry_run_digest FROM data_import_runs WHERE id = $1")
            .bind(run)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(stored, digest);

    let other =
        i.f.hr
            .start_apply(i.f.principal.clone(), run, body(&"0".repeat(64)))
            .await
            .unwrap_err();
    assert_eq!(
        (other.status.as_u16(), other.code),
        (409, "apply_in_progress")
    );
    let same =
        i.f.hr
            .start_apply(i.f.principal.clone(), run, body(&digest))
            .await
            .unwrap();
    assert!(
        matches!(same, Started::Running(ref j) if j.state == "queued"),
        "{same:?}"
    );
    let sync = i.apply(run, &digest).await.unwrap_err();
    assert_eq!(
        (sync.status.as_u16(), sync.code),
        (409, "apply_in_progress")
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        0
    );
}

/// A stale digest is refused before any job exists: 409, no job row, no
/// progress event, nobody written (refusals stay synchronous).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_stale_digest_is_refused_before_a_job_is_queued(pool: PgPool) {
    let i = importer(pool).await;
    let (run, _) = staged(&i, 2).await;
    let refused =
        i.f.hr
            .start_apply(i.f.principal.clone(), run, body(&"0".repeat(64)))
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "dry_run_digest_mismatch")
    );
    let org = i.f.principal.org_id;
    let none = i.f.hr.apply_job(org, run).await.unwrap_err();
    assert_eq!(none.status.as_u16(), 404);
    assert_eq!(progress_events(&i, run).await, 0);
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        0
    );
}

async fn age(i: &Importer, run: Uuid) {
    sqlx::query(
        "UPDATE data_import_runs SET apply_heartbeat_at = now() - interval '10 minutes' WHERE id = $1",
    )
    .bind(run)
    .execute(&i.owner)
    .await
    .unwrap();
}

/// A dead driver: before the leave command the job fails (`apply_interrupted`,
/// nothing written) and the operator re-sends; after it the loop finishes the
/// settle without doubling anything.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_dead_driver_is_failed_before_the_write_and_resumed_after(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 3).await;
    let org = i.f.principal.org_id;
    i.f.hr
        .start_apply(i.f.principal.clone(), run, body(&digest))
        .await
        .unwrap();
    age(&i, run).await;
    assert_eq!(i.f.hr.resume_stale_applies().await.unwrap(), 1);
    let job = i.f.hr.apply_job(org, run).await.unwrap();
    assert_eq!(job.state, "failed");
    assert_eq!(job.error.unwrap()["code"], "apply_interrupted");
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        0
    );

    assert_eq!(
        i.apply(run, &digest).await.unwrap().inserted,
        3,
        "re-sent, it applies"
    );
    sqlx::query(
        "UPDATE data_import_runs SET apply_job = jsonb_set(jsonb_set(apply_job, '{state}', \
           '\"settling\"'), '{done}', '0') WHERE id = $1",
    )
    .bind(run)
    .execute(&i.owner)
    .await
    .unwrap();
    age(&i, run).await;
    assert_eq!(i.f.hr.resume_stale_applies().await.unwrap(), 1);
    assert_eq!(i.f.hr.apply_job(org, run).await.unwrap().state, "done");
    assert_eq!(
        i.count("SELECT count(*) FROM employee_employment_profiles WHERE org_id = $1")
            .await,
        3,
        "a resumed settle never doubles"
    );
    assert_eq!(
        i.f.hr.resume_stale_applies().await.unwrap(),
        0,
        "nothing left to resume"
    );
}

/// #28: `import.apply.max_rows` bounds a run; over it the dry run and the
/// apply are 422 `import_row_limit` and nothing is stored.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_run_over_the_row_limit_is_refused(pool: PgPool) {
    let i = importer(pool).await;
    sqlx::query(
        "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
         VALUES ($1, 'import.apply.max_rows', '100'::jsonb, $2, 'TEST')",
    )
    .bind(i.org())
    .bind(*i.f.principal.user_id.as_uuid())
    .execute(&i.owner)
    .await
    .unwrap();
    let mut rows: Vec<Vec<String>> = vec![vec!["사번".into(), "성명".into(), "입사일".into()]];
    rows.extend((0..101).map(|n| vec![format!("E-{n}"), format!("직원{n}"), "2024-03-04".into()]));
    let rows: Vec<Vec<&str>> = rows
        .iter()
        .map(|r| r.iter().map(String::as_str).collect())
        .collect();
    let rows: Vec<&[&str]> = rows.iter().map(Vec::as_slice).collect();
    let run = i
        .preview(
            "big.xlsx",
            &[table("명부", 0, &rows)],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let refused = i.try_dry_run(run, decisions()).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "import_row_limit")
    );
    assert_eq!(refused.refusals.unwrap()[0]["max"], 100);
    let status: String = sqlx::query_scalar("SELECT status FROM data_import_runs WHERE id = $1")
        .bind(run)
        .fetch_one(&i.owner)
        .await
        .unwrap();
    assert_eq!(status, "PREVIEWED");
}
