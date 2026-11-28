// SPDX-License-Identifier: LicenseRef-Proprietary
//! An open pay-group run follows People at the close preflight, without saving,
//! and at attendance close; a legal entity with several pay groups, or a run that
//! is not regular, gets no roster from membership.
use super::pay_group::{JUNE, member, single_group_run};
use super::places::*;
use super::seed::*;
use console_payroll_adapter_postgres::get_run_in_tx;
use console_payroll_adapter_postgres::lifecycle::{
    LifecycleError, calculate_run_in_tx, close_attendance_in_tx, submit_run_in_tx,
};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

fn lines(keys: &[(&str, &str)]) -> Vec<(String, String)> {
    keys.iter()
        .map(|(key, status)| ((*key).to_owned(), (*status).to_owned()))
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_close_preflight_counts_a_member_hired_after_creation_and_persists_nothing(
    pool: PgPool,
) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    materialise_for(&pool, &f, JUNE).await;
    let created = statuses(&pool, f.run).await;
    // Recorded after the run was created, with no attendance yet.
    member(&pool, &f, "joiner", (le, site)).await;
    lock_period(&pool, f.org, JUNE).await;
    let verdict = preflight(&pool, &f).await;
    let attendance = &verdict.checks[0];
    // The note counts the joiner; their line exists only inside the preflight's
    // savepoint, so its id is no fix-link.
    let counted = attendance.note.as_deref().map(|note| {
        note.chars()
            .filter(char::is_ascii_digit)
            .collect::<String>()
    });
    assert_eq!(
        (
            (verdict.can_close, attendance.key, attendance.ok, counted),
            attendance.blocking_refs.clone(),
            statuses(&pool, f.run).await
        ),
        (
            (false, "attendance_material", false, Some("1".to_owned())),
            Vec::new(),
            created
        )
    );
}

/// The lines a refresh writes for later joiners are rolled back after the read
/// and after a refused close, so fix-links name saved lines only, and the
/// joiners never take the capped slots ahead of them.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn fix_links_name_saved_lines_however_many_joiners_sort_first(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "z-saved", (le, site)).await;
    materialise_for(&pool, &f, JUNE).await;
    let saved: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM payroll_draft_lines WHERE run_id=$1")
        .bind(f.run)
        .fetch_all(&pool)
        .await
        .unwrap();
    // As many joiners as the cap holds, none with attendance, all sorting first.
    for n in 0..50 {
        member(&pool, &f, &format!("a-{n:02}"), (le, site)).await;
    }
    lock_period(&pool, f.org, JUNE).await;
    let read = preflight(&pool, &f).await.checks[0].blocking_refs.clone();
    let actor = user(&pool, f.org).await;
    let mut tx = pool.begin().await.unwrap();
    let refused = close_attendance_in_tx(&mut tx, f.run, actor, OffsetDateTime::now_utc()).await;
    drop(tx);
    let Err(LifecycleError::PreflightBlocked(verdict)) = refused else {
        panic!("the close must be refused: {refused:?}");
    };
    assert_eq!(
        (read, verdict.checks[0].blocking_refs.clone()),
        (saved.clone(), saved)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_close_adds_a_member_hired_after_creation(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    materialise_for(&pool, &f, JUNE).await;
    member(&pool, &f, "joiner", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "joiner",
        attendance_row(),
    )
    .await;
    lock_period(&pool, f.org, JUNE).await;
    let closed = close(&pool, &f).await;
    assert_eq!(
        (closed, roster(&pool, &f).await),
        (
            Ok(()),
            vec![("emp-1".to_owned(), 0, 1), ("joiner".to_owned(), 0, 1)]
        )
    );
}

/// An exit before the period, recorded after the run was created, takes the
/// person off the roster as a VOID line, so their missing attendance no longer
/// holds the close.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_late_recorded_exit_before_the_period_voids_the_line_and_stops_blocking_close(
    pool: PgPool,
) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    let kept = member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    let leaver = member(&pool, &f, "leaver", (le, site)).await;
    materialise_for(&pool, &f, JUNE).await;
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_on=DATE '2026-05-20' WHERE id=$1",
    )
    .bind(leaver)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE employment_assignments SET valid_to=DATE '2026-05-21' WHERE employee_id=$1",
    )
    .bind(leaver)
    .execute(&pool)
    .await
    .unwrap();
    lock_period(&pool, f.org, JUNE).await;
    let closed = close(&pool, &f).await;
    // Off the roster, they are neither counted nor waiting on anything.
    let detail = {
        let mut tx = pool.begin().await.unwrap();
        get_run_in_tx(&mut tx, f.run, None, None)
            .await
            .unwrap()
            .unwrap()
    };
    let void_blockers: serde_json::Value =
        sqlx::query_scalar("SELECT blockers FROM payroll_draft_lines WHERE employee_id=$1")
            .bind(leaver)
            .fetch_one(&pool)
            .await
            .unwrap();
    let listed: Vec<_> = detail.lines.iter().map(|line| line.employee_id).collect();
    assert_eq!(
        (closed, statuses(&pool, f.run).await),
        (
            Ok(()),
            lines(&[("emp-1", "BLOCKED_LEGAL_GATE"), ("leaver", "VOID")])
        )
    );
    assert_eq!(
        (
            detail.lines_total,
            detail.missing_bank_account_count,
            listed,
            void_blockers
        ),
        (1, 1, vec![Some(kept)], serde_json::json!([]))
    );
}

/// Calculation leaves a retracted person's VOID line alone and does not count it,
/// and a run in which no line could be calculated has no pay to submit.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_void_line_stays_void_through_calculation_and_nothing_calculated_cannot_be_submitted(
    pool: PgPool,
) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    let leaver = member(&pool, &f, "leaver", (le, site)).await;
    materialise_for(&pool, &f, JUNE).await;
    sqlx::query(
        "UPDATE employment_assignments SET valid_to=DATE '2026-05-21' WHERE employee_id=$1",
    )
    .bind(leaver)
    .execute(&pool)
    .await
    .unwrap();
    lock_period(&pool, f.org, JUNE).await;
    close(&pool, &f).await.unwrap();
    let actor = user(&pool, f.org).await;
    let mut tx = pool.begin().await.unwrap();
    let blocked = calculate_run_in_tx(&mut tx, f.run)
        .await
        .unwrap()
        .blocked_lines;
    let submitted = submit_run_in_tx(&mut tx, f.run, actor).await;
    tx.commit().await.unwrap();
    assert_eq!(
        (
            blocked,
            statuses(&pool, f.run).await,
            submitted.map_err(|error| matches!(error, LifecycleError::NothingCalculated))
        ),
        (
            1,
            lines(&[("emp-1", "BLOCKED_LEGAL_GATE"), ("leaver", "VOID")]),
            Err(true)
        )
    );
}

/// A registration void holds the person while it destroys their details. A
/// roster written meanwhile waits for it and leaves the voided person off,
/// rather than copying the destroyed name onto a line.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_person_voided_while_the_roster_is_written_is_left_off(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    member(&pool, &f, "kept", (le, site)).await;
    let voided = member(&pool, &f, "voided", (le, site)).await;
    let voider = user(&pool, f.org).await;
    let mut void = pool.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM employees WHERE id=$1 FOR UPDATE")
        .bind(voided)
        .execute(&mut *void)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET employment_status='VOIDED',voided_at=now(),voided_by=$2,void_reason_code='MISTAKE',void_mode='SETUP' WHERE id=$1")
        .bind(voided).bind(voider).execute(&mut *void).await.unwrap();
    let writer = tokio::spawn({
        let (pool, f) = (
            pool.clone(),
            Fixture {
                org: f.org,
                run: f.run,
            },
        );
        async move { materialise_for(&pool, &f, JUNE).await }
    });
    // The void commits once the writer waits on a row lock, or has finished
    // without ever waiting.
    let waiting = "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()) FROM pg_sleep(0.02)";
    while !writer.is_finished()
        && !sqlx::query_scalar::<_, bool>(waiting)
            .fetch_one(&pool)
            .await
            .unwrap()
    {}
    void.commit().await.unwrap();
    writer.await.unwrap();
    assert_eq!(
        statuses(&pool, f.run).await,
        lines(&[("kept", "BLOCKED_LEGAL_GATE")])
    );
}

/// Off-cycle, correction and exit-settlement runs name their own people; the
/// group's membership, or an import for the period, adds nobody to them.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_regular_runs_get_a_roster(pool: PgPool) {
    let (f, le, site) = single_group_run(&pool, "OFF_CYCLE").await;
    member(&pool, &f, "emp-1", (le, site)).await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "emp-1",
        attendance_row(),
    )
    .await;
    let written = materialise_for(&pool, &f, JUNE).await;
    assert_eq!((written, statuses(&pool, f.run).await), (0, lines(&[])));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn clock_events_follow_the_pay_group_on_the_work_date(pool: PgPool) {
    use console_kernel_core::OrgId;
    use console_platform_db::{
        DbError, PERIOD_LOCKED, assert_employee_payroll_period_open, with_org_conn,
    };
    use console_platform_test_support::runtime_role_pool;
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    let employee = member(&pool, &f, "clocked", (le, site)).await;
    let group: Uuid = sqlx::query_scalar("SELECT pay_group_id FROM payroll_draft_runs WHERE id=$1")
        .bind(f.run)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO period_locks (org_id,domain,pay_group_id,period_start,period_end,reason)
                 VALUES ($1,'payroll',$2,$3,$4,'Payroll freeze')",
    )
    .bind(f.org)
    .bind(group)
    .bind(JUNE.0)
    .bind(JUNE.1)
    .execute(&pool)
    .await
    .unwrap();
    let rt = runtime_role_pool(&pool).await;
    let check = |day| {
        with_org_conn::<_, _, DbError>(&rt, OrgId::from_uuid(f.org), move |tx| {
            Box::pin(async move {
                Ok(assert_employee_payroll_period_open(tx, f.org, employee, day).await)
            })
        })
    };
    assert_eq!(
        check(JUNE.0).await.unwrap().unwrap_err().code,
        Some(PERIOD_LOCKED)
    );
    let next = pay_group(&pool, f.org, le, super::pay_group::MONTHLY).await;
    sqlx::query("INSERT INTO employee_pay_group_assignments(org_id,employee_id,pay_group_id,effective_from,effective_to_exclusive)
                 VALUES ($1,$2,$3,'2026-06-01','2026-06-15'),($1,$2,$4,'2026-06-15',NULL)")
        .bind(f.org).bind(employee).bind(group).bind(next).execute(&pool).await.unwrap();
    assert_eq!(
        check(JUNE.0).await.unwrap().unwrap_err().code,
        Some(PERIOD_LOCKED)
    );
    check(JUNE.1).await.unwrap().unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn held_exceptions_follow_the_group_series_once_on_recalculation(pool: PgPool) {
    let (f, le, _) = single_group_run(&pool, "REGULAR").await;
    let group: Uuid = sqlx::query_scalar("SELECT pay_group_id FROM payroll_draft_runs WHERE id=$1")
        .bind(f.run)
        .fetch_one(&pool)
        .await
        .unwrap();
    let other = pay_group(&pool, f.org, le, super::pay_group::MONTHLY).await;
    let actor = user(&pool, f.org).await;
    let mut origin = None;
    for (pay_group, kind) in [(group, "REGULAR"), (group, "OFF_CYCLE"), (other, "REGULAR")] {
        let prior: Uuid = sqlx::query_scalar("INSERT INTO payroll_draft_runs(org_id,pay_group_id,kind,attribution_month,pay_date,
            period_start,period_end,variable_period_start,variable_period_end,source_label)
            VALUES($1,$2,$3,'2026-05-01','2026-05-31','2026-05-01','2026-05-31','2026-05-01','2026-05-31',gen_random_uuid()::text) RETURNING id")
            .bind(f.org).bind(pay_group).bind(kind).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO payroll_run_exceptions(org_id,run_id,employee_display_name,kind,severity,summary_ko,status,
             resolved_by,resolved_at,resolved_reason) SELECT $1,$2,'Member','RETRO_ADJUSTMENT','warn','amount pending','HELD',$3,now(),'next payroll' FROM generate_series(1,2)")
            .bind(f.org).bind(prior).bind(actor).execute(&pool).await.unwrap();
        if pay_group == group && kind == "REGULAR" {
            origin = Some(prior);
        }
    }
    sqlx::query("UPDATE payroll_draft_runs SET status='ATTENDANCE_CLOSED' WHERE id=$1")
        .bind(f.run)
        .execute(&pool)
        .await
        .unwrap();
    for expected in [2, 0] {
        let mut tx = pool.begin().await.unwrap();
        let result = calculate_run_in_tx(&mut tx, f.run).await.unwrap();
        assert_eq!(result.exceptions_created, expected);
        tx.commit().await.unwrap();
    }
    let carried: Vec<(Uuid,Uuid)> = sqlx::query_as("SELECT carried_from_run_id,(detail->>'carried_from_exception_id')::uuid FROM payroll_run_exceptions WHERE run_id=$1 AND status='OPEN'")
        .bind(f.run).fetch_all(&pool).await.unwrap();
    assert_eq!(carried.len(), 2);
    assert!(carried.iter().all(|(parent, _)| Some(*parent) == origin));
    assert_ne!(carried[0].1, carried[1].1);
}
