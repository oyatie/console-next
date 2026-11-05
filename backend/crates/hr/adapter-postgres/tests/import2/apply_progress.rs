// SPDX-License-Identifier: LicenseRef-Proprietary
use std::time::Duration;

use sqlx::PgPool;

use crate::harness::importer;
use crate::mig_job::{body, staged};

async fn sample_while_settling(pool: PgPool, kill: bool, restart: bool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 300).await;
    let org = i.f.principal.org_id;
    i.f.hr
        .start_apply(i.f.principal.clone(), run, body(&digest))
        .await
        .unwrap();
    if restart {
        sqlx::query("UPDATE data_import_runs SET apply_job=jsonb_set(apply_job,'{state}','\"applying\"'), apply_heartbeat_at=now()-interval '10 minutes' WHERE id=$1")
            .bind(run).execute(&i.owner).await.unwrap();
        sqlx::query("UPDATE import_apply_progress SET done=100 WHERE run_id=$1")
            .bind(run)
            .execute(&i.owner)
            .await
            .unwrap();
        assert_eq!(i.f.hr.apply_job(org, run).await.unwrap().done, 100);
    }
    // A restarted driver must reset before its first chunk can publish progress.
    sqlx::raw_sql("CREATE TABLE paused_chunk(n int); GRANT SELECT ON paused_chunk TO console_rt;")
        .execute(&i.owner)
        .await
        .unwrap();
    sqlx::query("INSERT INTO paused_chunk(n) VALUES($1)")
        .bind(if restart { 1_i32 } else { 2_i32 })
        .execute(&i.owner)
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE FUNCTION pause_second_settle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           IF NEW.action='employee.import.settle' AND
             (SELECT count(*) FROM public.audit_events WHERE target_id=NEW.target_id
                AND action='employee.import.settle')=(SELECT n FROM public.paused_chunk) THEN
             PERFORM pg_advisory_xact_lock(1731);
           END IF;
           RETURN NEW;
         END $$;
         CREATE TRIGGER pause_second_settle AFTER INSERT ON audit_events
         FOR EACH ROW EXECUTE FUNCTION pause_second_settle();",
    )
    .execute(&i.owner)
    .await
    .unwrap();
    let mut gate = i.owner.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(1731)")
        .execute(&mut *gate)
        .await
        .unwrap();
    let sample = async {
        let observed = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let job = i.f.hr.apply_job(org, run).await.unwrap();
                if restart {
                    let waiting: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')",
                    ).fetch_one(&i.owner).await.unwrap();
                    if waiting { break i.f.hr.apply_job(org, run).await.unwrap(); }
                } else if job.done > 0 && job.done < job.total {
                    break job;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await;
        let emitted: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM resource_changes c JOIN audit_events a ON a.id=c.audit_event_id
             WHERE c.org_id=$1 AND c.resource_type='import_run' AND c.resource_id=$2
               AND a.action='data_import.apply.progress' AND (a.after_snap->>'done')::int=100)",
        ).bind(i.org()).bind(run.to_string()).fetch_one(&i.owner).await.unwrap();
        let people = i
            .count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await;
        if kill && observed.is_ok() {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let waiting: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')",
                    ).fetch_one(&i.owner).await.unwrap();
                    if waiting { break; }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            }).await.unwrap();
            sqlx::query(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()",
            )
            .execute(&i.owner)
            .await
            .unwrap();
        }
        sqlx::query("SELECT pg_advisory_unlock(1731)")
            .execute(&mut *gate)
            .await
            .unwrap();
        (observed, people, emitted)
    };
    let (result, (observed, people, emitted)) =
        tokio::join!(i.f.hr.drive_apply(Some(i.store.clone()), org, run), sample);
    let observed = observed.unwrap_or_else(|error| {
        panic!("progress must rise before the atomic apply commits: {error:?}; driver: {result:?}")
    });
    assert_eq!(
        (observed.done, observed.total),
        (if restart { 0 } else { 100 }, 300)
    );
    if !restart {
        assert!(
            emitted,
            "progress must emit an import_run event before the atomic apply commits"
        );
    }
    assert_eq!(people, 0, "progress must not expose uncommitted employees");
    let job = i.f.hr.apply_job(org, run).await.unwrap();
    let published: i64 =
        sqlx::query_scalar("SELECT done FROM import_apply_progress WHERE org_id=$1 AND run_id=$2")
            .bind(i.org())
            .bind(run)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(
        published,
        if kill { 100 } else { 200 },
        "terminal jobs ignore surviving progress"
    );
    if kill {
        assert!(result.is_err());
        assert_eq!(job.state, "failed", "stale progress must not hide failure");
        assert_eq!(job.done, 0);
        assert_eq!(
            i.count("SELECT count(*) FROM employees WHERE org_id=$1")
                .await,
            0
        );
        // A new attempt must reset the old side-channel count before its driver runs.
        i.f.hr
            .start_apply(i.f.principal.clone(), run, body(&digest))
            .await
            .unwrap();
        let retry = i.f.hr.apply_job(org, run).await.unwrap();
        assert_eq!((retry.state.as_str(), retry.done), ("queued", 0));
    } else {
        assert_eq!(result.unwrap().inserted, 300);
        assert_eq!((job.state.as_str(), job.done), ("done", 300));
        assert_eq!(job.report.unwrap().inserted, 300);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn progress_is_visible_before_the_atomic_apply_commits(pool: PgPool) {
    sample_while_settling(pool, false, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn killed_apply_ignores_stale_progress_and_retry_resets_it(pool: PgPool) {
    sample_while_settling(pool, true, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_stopped_apply_resets_progress_before_restarting(pool: PgPool) {
    sample_while_settling(pool, false, true).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_failed_progress_publication_does_not_abort_the_atomic_apply(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(&i, 300).await;
    sqlx::raw_sql(
        "CREATE FUNCTION fail_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           RAISE EXCEPTION 'injected progress failure';
         END $$;
         CREATE TRIGGER fail_progress BEFORE UPDATE ON import_apply_progress
         FOR EACH ROW WHEN (NEW.done > 0) EXECUTE FUNCTION fail_progress();",
    )
    .execute(&i.owner)
    .await
    .unwrap();
    let report = i.apply(run, &digest).await.unwrap();
    assert_eq!(report.inserted, 300);
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        300,
        "publication must never roll back employees"
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employee_employment_profiles WHERE org_id=$1")
            .await,
        300,
        "publication must never roll back employment profiles"
    );
    let job = i.f.hr.apply_job(i.f.principal.org_id, run).await.unwrap();
    assert_eq!((job.state.as_str(), job.done), ("done", 300));
    assert_eq!(job.report.unwrap().inserted, 300);
    let published: i64 =
        sqlx::query_scalar("SELECT done FROM import_apply_progress WHERE run_id=$1")
            .bind(run)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(published, 0, "the fault must actually prevent publication");
}
