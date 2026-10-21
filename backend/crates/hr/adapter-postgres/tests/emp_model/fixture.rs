//! Shared fixture: an org, an HR user, one employee, a `console_rt` pool.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::contract::RecordContractRequest;
use console_hr_domain::contract::ContractKind;
use console_hr_domain::profile::enums::PayUnit;
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

pub async fn fixture(pool: PgPool, with_profile: bool) -> Fixture {
    let org = OrgId::new();
    let user = UserId::new();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'EMP-MODEL test org')")
        .bind(*org.as_uuid())
        .bind(format!("emp-{}", &org.as_uuid().simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', $2, $3)")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"])
        .bind(*org.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, hire_date) \
         VALUES ($1, 'Co', '김수습', 'console', 'console', 1, $2, '2026-09-01') RETURNING id",
    )
    .bind(*org.as_uuid()).bind(Uuid::new_v4().to_string())
    .fetch_one(&pool).await.unwrap();
    if with_profile {
        sqlx::query(
            "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, phone_e164, base_pay, \
             idempotency_key, request_hash, created_by) VALUES ($1, $2, 'REGULAR', '+821012345678', 3000000, $3, $4, $5)",
        )
        .bind(employee).bind(*org.as_uuid()).bind(Uuid::new_v4().to_string()).bind("0".repeat(64)).bind(*user.as_uuid())
        .execute(&pool).await.unwrap();
    }
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

pub fn contract(kind: ContractKind, start: &str, end: Option<&str>) -> RecordContractRequest {
    RecordContractRequest {
        kind,
        start_date: start.to_owned(),
        end_date: end.map(str::to_owned),
        wage_won: 2_600_000,
        pay_unit: PayUnit::Monthly,
        weekly_minutes: Some(2400),
        supersedes_id: None,
    }
}

pub fn ops(value: Value) -> Vec<console_platform_preconditions::PatchOp> {
    serde_json::from_value(value).unwrap()
}
