#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! LC-B3 daily clock tick, as `console_rt` (the worker's role): two replicas
//! racing on one day emit once; the first run settles every computable due
//! date from the register (UNKNOWN stays dateless, a request-triggered item
//! waits); a later day emits only for cases whose items crossed a line.

use console_compliance_adapter_postgres::PgComplianceStore;
use console_hr_adapter_postgres::HrService;
use console_kernel_core::OrgId;
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;

fn today() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
}

/// A tenant with one live exit case (10 days ahead), backfilled into its case.
async fn live_exit(pool: &PgPool) -> (Uuid, Uuid) {
    let (org, hr) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'tick')")
        .bind(org)
        .bind(format!("tick-{}", &org.simple().to_string()[..12]))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', '{SUPER_ADMIN}', $2)")
        .bind(hr)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, hire_date) \
         VALUES ($1, 'A', '퇴직예정', 'console', 's', 1, 'k', '2020-01-02') RETURNING id",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    let case: Uuid = sqlx::query_scalar(
        "INSERT INTO employee_exit_cases (org_id, employee_id, effective_exit_date, site_manager_note, reported_by, \
             exit_reason_code) VALUES ($1, $2, $3, 'n', $4, 'PERSONAL') RETURNING id",
    )
    .bind(org)
    .bind(employee)
    .bind(today() + Duration::days(10))
    .bind(hr)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("SELECT lifecycle_backfill_exit_cases($1)")
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    (org, case)
}

async fn ticks(pool: &PgPool, org: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'lifecycle_case.clock_tick' \
         AND actor IS NULL AND target_type = 'lifecycle_case'",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn replicas_tick_once_a_day_and_later_days_emit_only_crossings(pool: PgPool) {
    let (org, case) = live_exit(&pool).await;
    let (quiet, _) = live_exit(&pool).await;
    let rt = runtime_role_pool(&pool).await;
    let register = PgComplianceStore::new(rt.clone())
        .statutory_register()
        .await
        .unwrap();
    let (a, b) = (HrService::new(rt.clone()), HrService::new(rt));
    let id = OrgId::from_uuid(org);

    // Two replicas, one day: exactly one claims it.
    let (first, second) = tokio::join!(
        a.case_clock_tick(id, today(), register.clone()),
        b.case_clock_tick(id, today(), register.clone()),
    );
    let mut runs = [first.unwrap(), second.unwrap()];
    runs.sort_unstable();
    assert_eq!(runs, [0, 1], "one case, one claim");
    assert_eq!(ticks(&pool, org).await, 1);
    assert_eq!(
        a.case_clock_tick(id, today(), register.clone())
            .await
            .unwrap(),
        0
    );

    let exit = today() + Duration::days(10);
    let clocks: Vec<(String, Option<Date>, String)> = sqlx::query_as(
        "SELECT item_key, due_date, due_disposition FROM lifecycle_case_items \
         WHERE case_id = $1 AND item_key IN ('X1', 'X3', 'X6', 'X9', 'X10', 'X12') ORDER BY item_key",
    )
    .bind(case)
    .fetch_all(&pool)
    .await
    .unwrap();
    let ei_nps = (exit.replace_day(1).unwrap() + Duration::days(31))
        .replace_day(15)
        .unwrap();
    assert_eq!(
        clocks,
        [
            ("X1".into(), Some(exit), "HOLD".into()),
            ("X10".into(), Some(exit + Duration::days(14)), "HOLD".into()),
            ("X12".into(), None, "HOLD".into()),
            ("X3".into(), None, "UNKNOWN".into()),
            ("X6".into(), Some(exit + Duration::days(14)), "HOLD".into()),
            ("X9".into(), Some(ei_nps), "HOLD".into()),
        ]
    );

    sqlx::query("INSERT INTO platform_setting_overrides(key,value,effective_from) VALUES('display.deadline_due_soon_days','2',now()-interval '1 day')")
        .execute(&pool).await.unwrap();
    // Day five is outside the two-day window; a fixed seven-day window emits early.
    assert_eq!(
        a.case_clock_tick(id, today() + Duration::days(5), register.clone())
            .await
            .unwrap(),
        0
    );
    assert_eq!(ticks(&pool, org).await, 1);
    // Eight days later X1 (due on the exit date) enters the configured window: the
    // case changes once. The other tenant ticks its own day independently.
    let later = today() + Duration::days(8);
    assert_eq!(
        a.case_clock_tick(id, later, register.clone())
            .await
            .unwrap(),
        1
    );
    assert_eq!(ticks(&pool, org).await, 2);
    // The next day nothing crosses.
    assert_eq!(
        a.case_clock_tick(id, later + Duration::days(1), register.clone())
            .await
            .unwrap(),
        0
    );
    assert_eq!(ticks(&pool, org).await, 2);
    assert_eq!(
        b.case_clock_tick(OrgId::from_uuid(quiet), later, register)
            .await
            .unwrap(),
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tick_resolves_the_display_window_at_its_kst_date(pool: PgPool) {
    let (org, _) = live_exit(&pool).await;
    let day = today();
    let later = day + Duration::days(5);
    let midnight = |date: Date| {
        date.with_hms(0, 0, 0)
            .unwrap()
            .assume_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
    };
    sqlx::query(
        "INSERT INTO platform_setting_overrides(key,value,effective_from) VALUES \
        ('display.deadline_due_soon_days','1',$1),('display.deadline_due_soon_days','5',$2)",
    )
    .bind(midnight(day - Duration::days(1)))
    .bind(midnight(later))
    .execute(&pool)
    .await
    .unwrap();
    let rt = runtime_role_pool(&pool).await;
    let register = PgComplianceStore::new(rt.clone())
        .statutory_register()
        .await
        .unwrap();
    let service = HrService::new(rt);
    let org = OrgId::from_uuid(org);
    assert_eq!(
        service
            .case_clock_tick(org, day, register.clone())
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        service.case_clock_tick(org, later, register).await.unwrap(),
        1,
        "the five-day window takes effect on the tick date, even for a replay or future tick"
    );
    assert_eq!(ticks(&pool, *org.as_uuid()).await, 2);
}
