#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-12 through the `HrService` entry points, on a `console_rt` pool: the
//! fixed-term limit on CONTRACT_RENEWAL (from the statutory register), 육아휴직
//! taken out, the hire-date fallback flagged not blocked, and the governed
//! FIXED_TERM_OVER_TWO_YEARS exception consumed once.

#[path = "support/go_live.rs"]
mod go_live;
use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

struct Fixture {
    hr: HrService,
    owner: PgPool,
    principal: Principal,
    org: Uuid,
    user: Uuid,
    employee: Uuid,
}

/// A CONTRACT employee hired 2024-11-01 whose contract window ends `end`
/// (none: the hire-date fallback).
async fn fixture(pool: PgPool, window: Option<(&str, &str)>) -> Fixture {
    let (org, user) = (OrgId::new(), UserId::new());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'BW-12 test org')")
        .bind(*org.as_uuid())
        .bind(format!(
            "bw12-{}",
            &org.as_uuid().simple().to_string()[..12]
        ))
        .execute(&pool)
        .await
        .unwrap();
    go_live::go_live(&pool, *org.as_uuid()).await;
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', $2, $3)")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"])
        .bind(*org.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, \
         source_key, hire_date) VALUES ($1, 'Co', '계약직', 'console', 'console', 1, $2, '2024-11-01') \
         RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, phone_e164, \
         base_pay, idempotency_key, request_hash, created_by, contract_start_date, contract_end_date) \
         VALUES ($1, $2, 'CONTRACT', '+821012345678', 3000000, $3, $4, $5, $6::DATE, $7::DATE)",
    )
    .bind(employee)
    .bind(*org.as_uuid())
    .bind(Uuid::new_v4().to_string())
    .bind("0".repeat(64))
    .bind(*user.as_uuid())
    .bind(window.map(|w| w.0))
    .bind(window.map(|w| w.1))
    .execute(&pool)
    .await
    .unwrap();
    let options = pool.connect_options().as_ref().clone();
    let rt = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt")
                    .execute(conn)
                    .await
                    .map(|_| ())
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    let principal = Principal::new(
        user,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    Fixture {
        hr: HrService::new(rt),
        owner: pool,
        principal,
        org: *org.as_uuid(),
        user: *user.as_uuid(),
        employee,
    }
}

fn renewal(end: &str, exception_id: Option<Uuid>) -> CreateEmployeeLifecycleEventRequest {
    let mut body: CreateEmployeeLifecycleEventRequest = serde_json::from_value(json!({
        "event_type": "CONTRACT_RENEWAL",
        "effective_date": "2026-09-30",
        "contract_end_date": end,
        "comment": "BW-12",
        "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true},
    }))
    .unwrap();
    body.exception_id = exception_id;
    body
}

impl Fixture {
    async fn renew(&self, end: &str, exception_id: Option<Uuid>) -> Result<(), (u16, String)> {
        self.hr
            .record_lifecycle_event(
                self.principal.clone(),
                self.employee,
                Uuid::new_v4().to_string(),
                renewal(end, exception_id),
            )
            .await
            .map(|_| ())
            .map_err(|e| (e.status.as_u16(), e.code.to_owned()))
    }

    /// A RECORDED high-risk exception (sole-holder fallback) for this renewal.
    async fn exception(&self, ground: &str, end: &str) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO governed_exceptions (org_id, rule_code, risk, subject_type, subject_id, \
             reason_code, fingerprint, settings_snapshot, requested_by, step_up_assertion_id, status, \
             fallback_kind, review_due_at, expires_at) \
             VALUES ($1, 'FIXED_TERM_OVER_TWO_YEARS', 'HIGH', 'EMPLOYEE', $2, $3, \
             governed_exception_fingerprint($4, '{}'::daterange[]), '{}', $5, $6, 'RECORDED', \
             'SOLE_HOLDER', now() + interval '7 days', now() + interval '1 day') RETURNING id",
        )
        .bind(self.org)
        .bind(self.employee)
        .bind(ground)
        .bind(json!({"employee_id": self.employee, "contract_end_date": end}))
        .bind(self.user)
        .bind(Uuid::new_v4())
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_renewal_past_two_years_needs_an_exception_with_a_statutory_ground(pool: PgPool) {
    // 2024-11-01 .. 2026-09-30 is 23 months; the limit falls on 2026-10-31.
    let f = fixture(pool, Some(("2024-11-01", "2026-09-30"))).await;
    let view =
        f.hr.employee_fixed_term(f.principal.clone(), f.employee)
            .await
            .unwrap();
    assert!(view.applies);
    assert_eq!(view.basis, Some("CONTRACT_HISTORY"));
    assert_eq!(view.two_year_date.as_deref(), Some("2026-10-31"));

    assert_eq!(
        f.renew("2026-12-31", None).await.unwrap_err(),
        (409, "fixed_term_limit".to_owned())
    );
    let other = f.exception("OTHER", "2026-12-31").await;
    assert_eq!(
        f.renew("2026-12-31", Some(other)).await.unwrap_err(),
        (422, "fixed_term_exemption_ground_invalid".to_owned())
    );
    let wrong_end = f.exception("OLDER_WORKER", "2027-01-31").await;
    assert_eq!(
        f.renew("2026-12-31", Some(wrong_end)).await.unwrap_err().0,
        409
    );

    let older = f.exception("OLDER_WORKER", "2026-12-31").await;
    f.renew("2026-12-31", Some(older)).await.unwrap();
    let consumed: bool =
        sqlx::query_scalar("SELECT consumed_at IS NOT NULL FROM governed_exceptions WHERE id = $1")
            .bind(older)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert!(consumed);
    // Inside the limit needs nothing; a shortening is not checked here.
    let g = fixture(f.owner.clone(), Some(("2024-11-01", "2026-09-30"))).await;
    g.renew("2026-10-31", None).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn childcare_leave_does_not_count_and_the_fallback_is_flagged_not_blocked(pool: PgPool) {
    let f = fixture(pool, Some(("2024-11-01", "2026-09-30"))).await;
    for (kind, on, leave, back) in [
        (
            "LEAVE_OF_ABSENCE",
            "2025-03-01",
            Some("CHILDCARE"),
            Some("2025-07-01"),
        ),
        ("RETURN_FROM_LEAVE", "2025-07-01", None, None),
    ] {
        sqlx::query(
            "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, to_status, \
             effective_date, comment, created_by, leave_type, expected_return_date) \
             VALUES ($1, $2, $3, 'ACTIVE', $4, 'BW-12', $5, $6, $7::DATE)",
        )
        .bind(f.org)
        .bind(f.employee)
        .bind(kind)
        .bind(on)
        .bind(f.user)
        .bind(leave)
        .bind(back)
        .execute(&f.owner)
        .await
        .unwrap();
    }
    // Four months out: the limit moves about four months later, so this fits.
    f.renew("2026-12-31", None).await.unwrap();

    let g = fixture(f.owner.clone(), None).await;
    let view =
        g.hr.employee_fixed_term(g.principal.clone(), g.employee)
            .await
            .unwrap();
    assert_eq!(view.basis, Some("HIRE_DATE_FALLBACK"));
    g.renew("2027-06-30", None).await.unwrap();
}
