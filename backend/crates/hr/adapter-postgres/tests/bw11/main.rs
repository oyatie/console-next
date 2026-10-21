#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-11 through the `HrService` entry points, on a `console_rt` pool: no
//! silent supersede of a scheduled event, the version pins, and the hire-date
//! floor; `void` covers correction and rescission.

mod hooks;
mod solo_correction;
mod void;

#[path = "../support/go_live.rs"]
mod go_live;
use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

pub struct Fixture {
    pub hr: HrService,
    pub owner: PgPool,
    pub principal: Principal,
    pub employee: Uuid,
}

pub async fn fixture(pool: PgPool) -> Fixture {
    let (org, user) = (OrgId::new(), UserId::new());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'BW-11 test org')")
        .bind(*org.as_uuid())
        .bind(format!(
            "bw11-{}",
            &org.as_uuid().simple().to_string()[..12]
        ))
        .execute(&pool)
        .await
        .unwrap();
    go_live::go_live(&pool, *org.as_uuid()).await;
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR 담당', $2, $3)",
    )
    .bind(*user.as_uuid())
    .bind(["SUPER_ADMIN"])
    .bind(*org.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, position, source_filename, source_sheet, \
         source_row, source_key, hire_date) \
         VALUES ($1, 'Co', '정하늘', '사원', 'console', 'console', 1, $2, '2026-01-02') RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&pool)
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
        employee,
    }
}

pub fn promote(to: &str, on: &str, extra: Value) -> CreateEmployeeLifecycleEventRequest {
    let mut body = json!({
        "event_type": "PROMOTE",
        "to_position": to,
        "effective_date": on,
        "comment": "BW-11",
        "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true},
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

impl Fixture {
    pub async fn record(
        &self,
        body: CreateEmployeeLifecycleEventRequest,
    ) -> Result<Value, (u16, String, Value)> {
        self.hr
            .record_lifecycle_event(
                self.principal.clone(),
                self.employee,
                Uuid::new_v4().to_string(),
                body,
            )
            .await
            .map_err(|e| {
                (
                    e.status.as_u16(),
                    e.code.to_owned(),
                    e.refusals.unwrap_or(Value::Null),
                )
            })
    }

    pub async fn version(&self) -> i32 {
        self.hr
            .lifecycle_events(
                self.principal.clone(),
                self.employee,
                Default::default(),
                false,
            )
            .await
            .unwrap()
            .head_version
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_second_event_of_a_kind_and_date_is_refused_unless_it_names_the_first(pool: PgPool) {
    let f = fixture(pool).await;
    let first = f
        .record(promote("과장", "2999-01-01", json!({})))
        .await
        .unwrap();
    let (status, code, refusals) = f
        .record(promote("차장", "2999-01-01", json!({})))
        .await
        .unwrap_err();
    assert_eq!((status, code.as_str()), (409, "scheduled_conflict"));
    assert_eq!(refusals[0]["event_id"], first["id"]);
    assert_eq!(refusals[0]["recorded_by"], "HR 담당");

    let other =
        json!({"replaces_event_id": Uuid::new_v4(), "replace_reason_code": "SCHEDULE_CHANGED"});
    assert_eq!(
        f.record(promote("차장", "2999-01-01", other))
            .await
            .unwrap_err()
            .1,
        "scheduled_conflict"
    );
    let elsewhere =
        json!({"replaces_event_id": first["id"], "replace_reason_code": "SCHEDULE_CHANGED"});
    let refused = f.record(promote("차장", "2999-02-01", elsewhere)).await;
    assert_eq!(refused.unwrap_err().1, "scheduled_replace_mismatch");
    let no_reason = json!({"replaces_event_id": first["id"]});
    assert_eq!(
        f.record(promote("차장", "2999-01-01", no_reason))
            .await
            .unwrap_err()
            .1,
        "reason_code_required"
    );

    let named =
        json!({"replaces_event_id": first["id"], "replace_reason_code": "SCHEDULE_CHANGED"});
    let second = f
        .record(promote("차장", "2999-01-01", named))
        .await
        .unwrap();
    let (state, superseded_by, code): (String, Option<Uuid>, Option<String>) = sqlx::query_as(
        "SELECT state, superseded_by, cancel_reason_code FROM employee_lifecycle_events WHERE id = $1::uuid",
    )
    .bind(first["id"].as_str().unwrap())
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(state, "CANCELLED");
    assert_eq!(
        superseded_by.map(|id| id.to_string()),
        second["id"].as_str().map(str::to_owned)
    );
    assert_eq!(code.as_deref(), Some("SCHEDULE_CHANGED"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_stale_version_or_a_date_before_hire_is_refused(pool: PgPool) {
    let f = fixture(pool).await;
    assert_eq!(f.version().await, 0);
    let before_hire = f
        .record(promote("대리", "2025-12-31", json!({})))
        .await
        .unwrap_err();
    assert_eq!(
        (before_hire.0, before_hire.1.as_str()),
        (422, "effective_date_before_hire")
    );

    f.record(promote(
        "대리",
        "2026-09-01",
        json!({"expected_head_version": 0}),
    ))
    .await
    .unwrap();
    assert_eq!(f.version().await, 1);
    let (status, code, refusals) = f
        .record(promote(
            "과장",
            "2026-09-02",
            json!({"expected_head_version": 0}),
        ))
        .await
        .unwrap_err();
    assert_eq!((status, code.as_str()), (409, "stale_record"));
    assert_eq!(refusals[0]["event_type"], "PROMOTE");
    assert_eq!(refusals[0]["recorded_by"], "HR 담당");
    f.record(promote(
        "과장",
        "2026-09-02",
        json!({"expected_head_version": 1}),
    ))
    .await
    .unwrap();
    // A scheduled event moves nothing until it applies.
    f.record(promote("차장", "2999-01-01", json!({})))
        .await
        .unwrap();
    assert_eq!(f.version().await, 2);
}
