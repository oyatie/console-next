//! MR-26 등록 취소 on real registrations, run as `console_rt`: the shared
//! helpers, and the SETUP delete (tombstoned at once, 사번 freed). The
//! governed void after 운영 시작 is in `void_governed.rs`.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_hr_adapter_postgres::registration_void::{SetupDeleteRequest, VoidEmployeeRequest};
use console_kernel_core::{BranchScope, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::fixture::{Fixture, fixture};

pub(crate) const SECOND: SecondPersonContext = SecondPersonContext {
    other_eligible_holders: 1,
    routed: true,
    sole_holder_refuse: false,
};

pub(crate) async fn version(pool: &PgPool, id: Uuid) -> String {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
    at.format(&Rfc3339).unwrap()
}

pub(crate) async fn register(f: &Fixture, key: &str, hire: &str, number: &str) -> Uuid {
    let mut body = f.body(key, "REGULAR");
    body.hire_date = Some(hire.into());
    body.employee_number = number.into();
    f.create(body).await.unwrap().employee.id
}

pub(crate) async fn go_live(pool: &PgPool, org: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING'")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

/// The runtime role's view, RLS armed (the voided row is hidden).
pub(crate) async fn visible(f: &Fixture, id: Uuid) -> bool {
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(f.principal.org_id.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM employees WHERE id = $1)")
        .bind(id)
        .fetch_one(tx.as_mut())
        .await
        .unwrap()
}

pub(crate) async fn tombstone(
    pool: &PgPool,
    id: Uuid,
) -> (String, String, Option<String>, String, bool) {
    sqlx::query_as(
        "SELECT employment_status, name, employee_number, void_mode, pii_destroyed_at IS NOT NULL \
         FROM employees WHERE id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub(crate) fn delete_body(expected: String, register_kept: bool) -> SetupDeleteRequest {
    serde_json::from_value(json!({
        "expected_updated_at": expected, "reason_code": "DUPLICATE_ENTRY",
        "register_kept": register_kept,
    }))
    .unwrap()
}

pub(crate) fn void_body(expected: String, attest: bool) -> VoidEmployeeRequest {
    serde_json::from_value(json!({
        "expected_updated_at": expected, "reason_code": "NEVER_JOINED",
        "attest_never_worked": attest,
    }))
    .unwrap()
}

pub(crate) fn code<T: std::fmt::Debug>(result: Result<T, HrError>) -> (u16, &'static str) {
    let error = result.unwrap_err();
    (error.status.as_u16(), error.code)
}

pub(crate) async fn second_hr(pool: &PgPool, f: &Fixture) -> Principal {
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR2', $2, $3)")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"])
        .bind(*f.principal.org_id.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    Principal::new(
        user,
        f.principal.org_id,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_setup_delete_tombstones_at_once_and_frees_the_number(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let id = register(&f, "sd-1", "2026-09-01", "S-001").await;
    let stale = code(
        f.hr.setup_delete_employee(
            f.principal.clone(),
            id,
            delete_body("2020-01-01T00:00:00Z".into(), false),
        )
        .await,
    );
    assert_eq!(stale.0, 409);
    let done =
        f.hr.setup_delete_employee(
            f.principal.clone(),
            id,
            delete_body(version(&pool, id).await, false),
        )
        .await
        .unwrap();
    assert_eq!(done.status, "VOIDED");
    assert!(!visible(&f, id).await, "a voided record leaves every read");
    assert_eq!(
        tombstone(&pool, id).await,
        (
            "VOIDED".into(),
            "(파기됨)".into(),
            None,
            "SETUP".into(),
            true
        )
    );
    // The person's name history and the profile's phone went with it.
    let legal_name: Option<String> = sqlx::query_scalar(
        "SELECT r.attributes ->> 'legal_name' FROM person_revisions r \
         JOIN employee_person_bindings b ON b.org_id = r.org_id AND b.person_id = r.person_id \
         WHERE b.employee_id = $1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(legal_name, None);
    let phone: Option<String> = sqlx::query_scalar(
        "SELECT phone_e164 FROM employee_employment_profiles WHERE employee_id = $1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(phone, None);
    // The 사번 is free again, and the 「취소된 등록」 list shows the tombstone.
    register(&f, "sd-2", "2026-09-01", "S-001").await;
    let list = f.hr.list_voided(f.principal.clone()).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].employee_id, id);
    // After 운영 시작 there is no delete, only the governed void.
    let other = register(&f, "sd-3", "2026-09-01", "").await;
    go_live(&pool, *f.principal.org_id.as_uuid()).await;
    assert_eq!(
        code(
            f.hr.setup_delete_employee(
                f.principal.clone(),
                other,
                delete_body(version(&pool, other).await, false),
            )
            .await
        ),
        (409, "phase_not_setup")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_exited_person_inside_the_register_period_needs_the_register_kept(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let id = register(&f, "ex-1", "2025-01-02", "X-001").await;
    sqlx::query(
        "UPDATE employees SET employment_status = 'EXITED', \
         exit_date = to_char((now() AT TIME ZONE 'Asia/Seoul')::date - 30, 'YYYY-MM-DD') WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        code(
            f.hr.setup_delete_employee(
                f.principal.clone(),
                id,
                delete_body(version(&pool, id).await, false),
            )
            .await
        ),
        (409, "exited_register_confirmation_required")
    );
    f.hr.setup_delete_employee(
        f.principal.clone(),
        id,
        delete_body(version(&pool, id).await, true),
    )
    .await
    .unwrap();
}
