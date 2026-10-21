//! Shared fixture: an org, an HR user, employees with no Person binding (as
//! trunk import leaves them), a `console_rt` pool.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
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
    let org = OrgId::new();
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'EMP-RECORD test org')",
    )
    .bind(*org.as_uuid())
    .bind(format!("rec-{}", &org.as_uuid().simple().to_string()[..12]))
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
    /// An employee row with no Person binding, as trunk import writes it.
    pub async fn employee(&self, number: &str) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO employees (org_id, company, name, employee_number, source_filename, source_sheet, \
             source_row, source_key, hire_date) VALUES ($1, 'Co', '김인사', $2, 'sheet.xlsx', 'S', 1, $3, '2026-09-01') \
             RETURNING id",
        )
        .bind(self.org)
        .bind(number)
        .bind(Uuid::new_v4().to_string())
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    /// A pre-MR-28 duplicate 사번 as 0292 flags it: the flag guard admits it
    /// only from the migration, so the row is written the way that UPDATE ran.
    pub async fn legacy_duplicate(&self, number: &str) -> Uuid {
        let id = self.employee(&format!("{number}-legacy")).await;
        let mut tx = self.owner.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query(
            "UPDATE employees SET employee_number = $2, employee_number_legacy_duplicate = true \
             WHERE id = $1",
        )
        .bind(id)
        .bind(number)
        .execute(tx.as_mut())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        id
    }

    pub async fn count(&self, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(self.org)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }

    /// Turn a section on. A loosening takes effect at once only while the
    /// tenant is onboarding (no employees yet), so call it before `employee`.
    pub async fn switch_on(&self, key: &str) {
        sqlx::query(
            "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
             VALUES ($1, $2, 'true'::jsonb, $3, 'TEST')",
        )
        .bind(self.org)
        .bind(key)
        .bind(self.user)
        .execute(&self.owner)
        .await
        .unwrap();
    }

    /// Turn a section off (a tightening: in force at once).
    pub async fn switch_off(&self, key: &str) {
        sqlx::query(
            "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
             VALUES ($1, $2, 'false'::jsonb, $3, 'TEST')",
        )
        .bind(self.org)
        .bind(key)
        .bind(self.user)
        .execute(&self.owner)
        .await
        .unwrap();
    }
}

pub fn education(school: &str) -> Value {
    json!({ "school": school, "level": "BACHELOR", "major": "경영학", "status": "GRADUATED",
            "entered_on": "2010-03-02", "ended_on": "2014-02-20" })
}

pub fn military(status: &str) -> Value {
    json!({ "status": status })
}
