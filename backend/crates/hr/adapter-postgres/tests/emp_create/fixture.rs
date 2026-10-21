//! An org, a SUPER_ADMIN, an active branch and an assignable 사업장 unit.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::directory::create_core::create_employee_core;
use console_hr_adapter_postgres::directory::normalize::normalize_create_employee_request;
use console_hr_adapter_postgres::directory::types::{
    CreateEmployeeRequest, EmployeeDetailResponse,
};
use console_hr_adapter_postgres::{HrError, HrService};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

pub struct Fixture {
    pub hr: HrService,
    pub rt: PgPool,
    pub principal: Principal,
    pub branch: Uuid,
    pub unit: Uuid,
}

pub async fn fixture(pool: PgPool) -> Fixture {
    let org = OrgId::new();
    let user = UserId::new();
    let o = *org.as_uuid();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'EMP-CREATE test org')",
    )
    .bind(o)
    .bind(format!("empc-{}", &o.simple().to_string()[..12]))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', $2, $3)")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"])
        .bind(o)
        .execute(&pool)
        .await
        .unwrap();
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ('R', $1) RETURNING id")
            .bind(o)
            .fetch_one(&pool)
            .await
            .unwrap();
    let branch: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, 'B', $2) RETURNING id",
    )
    .bind(region)
    .bind(o)
    .fetch_one(&pool)
    .await
    .unwrap();
    let unit = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(o)
        .bind(unit)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('00', 32), 'hex'), \
                 '{\"name\": \"site\", \"kind\": \"site\"}'::jsonb, '{}'::jsonb)",
    )
    .bind(o)
    .bind(unit)
    .bind(*user.as_uuid())
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
    Fixture {
        hr: HrService::new(rt.clone()),
        rt,
        principal: Principal::new(
            user,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        ),
        branch,
        unit,
    }
}

impl Fixture {
    /// A registration body with the legacy required fields filled.
    pub fn body(&self, key: &str, employment_type: &str) -> CreateEmployeeRequest {
        CreateEmployeeRequest {
            name: "김등록".into(),
            company: "Co".into(),
            employment_type: employment_type.into(),
            phone: "010-1234-5678".into(),
            org_unit_id: Some(self.unit),
            position: "사원".into(),
            site: "본사".into(),
            home_branch_id: Some(self.branch),
            idempotency_key: key.into(),
            hire_date: Some("2026-09-01".into()),
            ..Default::default()
        }
    }

    /// The create transaction the endpoint runs, minus the post-commit
    /// home-branch routing (a leave-command concern this test does not need).
    pub async fn create(
        &self,
        body: CreateEmployeeRequest,
    ) -> Result<EmployeeDetailResponse, HrError> {
        let request = normalize_create_employee_request(body)?;
        let hash = serde_json::to_string(&request).unwrap();
        let org = *self.principal.org_id.as_uuid();
        let mut tx = self.rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let (detail, _) = create_employee_core(
            &mut tx,
            org,
            self.principal.user_id,
            &request,
            &console_hr_adapter_postgres::digest::sha256_hex(hash.as_bytes()),
            Uuid::new_v4(),
        )
        .await?;
        tx.commit().await.unwrap();
        Ok(detail)
    }
}
