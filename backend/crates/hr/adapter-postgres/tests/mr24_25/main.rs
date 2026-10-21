#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-24 / MR-25 through the `HrService` entry points, on a `console_rt` pool
//! (0266's grants, triggers and checks are what is proved): the five typed
//! catalogs, a 직급 PROMOTE, the dated APPOINT (직책·직무·직군), the dated
//! 고용형태 전환, their rescission, scheduling and bulk path.

mod catalog;
mod change_sets;
mod employment;
#[path = "../support/go_live.rs"]
mod go_live;
use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_hr_adapter_postgres::lifecycle::void::RescindLifecycleEventRequest;
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
    pub org: Uuid,
    pub user: Uuid,
}

pub async fn fixture(pool: PgPool) -> Fixture {
    let (org, user) = (OrgId::new(), UserId::new());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'MR-24/25 org')")
        .bind(*org.as_uuid())
        .bind(format!(
            "mr2425-{}",
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
    }
}

impl Fixture {
    /// An employee; with `employment_type`, also its profile (and a window
    /// for CONTRACT).
    pub async fn employee(&self, employment_type: Option<&str>) -> Uuid {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO employees (org_id, company, name, position, job, source_filename, \
             source_sheet, source_row, source_key, hire_date) VALUES ($1, 'Co', '한결', '사원', \
             '생산', 'console', 'console', 1, $2, '2025-01-02') RETURNING id",
        )
        .bind(self.org)
        .bind(Uuid::new_v4().to_string())
        .fetch_one(&self.owner)
        .await
        .unwrap();
        if let Some(kind) = employment_type {
            let window = (kind == "CONTRACT").then_some(("2025-01-02", "2026-12-31"));
            sqlx::query(
                "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, \
                 phone_e164, base_pay, idempotency_key, request_hash, created_by, \
                 contract_start_date, contract_end_date) \
                 VALUES ($1, $2, $3, '+821012345678', 3000000, $4, $5, $6, $7::DATE, $8::DATE)",
            )
            .bind(id)
            .bind(self.org)
            .bind(kind)
            .bind(Uuid::new_v4().to_string())
            .bind("0".repeat(64))
            .bind(self.user)
            .bind(window.map(|w| w.0))
            .bind(window.map(|w| w.1))
            .execute(&self.owner)
            .await
            .unwrap();
        }
        id
    }

    pub async fn entry(&self, kind: &str, label: &str, rank: Option<i32>) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO job_titles (org_id, kind, label, grade_rank, created_by) \
             VALUES ($1, $2, $3, $4, $5) RETURNING id",
        )
        .bind(self.org)
        .bind(kind)
        .bind(label)
        .bind(rank)
        .bind(self.user)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    pub async fn record(&self, employee: Uuid, body: Value) -> Result<Value, (u16, String)> {
        let body: CreateEmployeeLifecycleEventRequest = serde_json::from_value(body).unwrap();
        let key = Uuid::new_v4().to_string();
        self.hr
            .record_lifecycle_event(self.principal.clone(), employee, key, body)
            .await
            .map_err(|e| (e.status.as_u16(), e.code.to_owned()))
    }

    pub async fn rescind(&self, employee: Uuid, event: &Value) {
        let id = Uuid::parse_str(event["id"].as_str().unwrap()).unwrap();
        let body: RescindLifecycleEventRequest =
            serde_json::from_value(json!({"reason_code": "INPUT_ERROR", "confirm_cascades": true}))
                .unwrap();
        self.hr
            .rescind_lifecycle_event(self.principal.clone(), employee, id, body)
            .await
            .unwrap();
    }

    /// grade, 직책, 직무 id, 직무 text, 직군.
    pub async fn head(
        &self,
        employee: Uuid,
    ) -> (
        Option<Uuid>,
        Option<Uuid>,
        Option<Uuid>,
        Option<String>,
        Option<Uuid>,
    ) {
        sqlx::query_as("SELECT grade_id, position_kind_id, job_id, job, job_family_id FROM employees WHERE id = $1")
            .bind(employee)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }

    pub async fn employment(&self, employee: Uuid) -> (String, Option<String>, Option<String>) {
        sqlx::query_as(
            "SELECT employment_type, contract_start_date::TEXT, contract_end_date::TEXT \
             FROM employee_employment_profiles WHERE employee_id = $1",
        )
        .bind(employee)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }
}

pub fn event(event_type: &str, on: &str, extra: Value) -> Value {
    let mut body = json!({"event_type": event_type, "effective_date": on, "comment": "MR-24/25"});
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    body
}
