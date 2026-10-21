//! The tenant of the own-record tests: an ops account, employees, an HR worker
//! linked to their own record, and a grant that makes another account a holder.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::exits::types::{
    CloseEmployeeExitCaseRequest, ConfirmEmployeeExitCaseRequest, ReportEmployeeExitCaseRequest,
};
use console_hr_adapter_postgres::{HrError, HrService};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

use crate::go_live;

const HR_FEATURES: [Feature; 6] = [
    Feature::EmployeeDirectoryRead,
    Feature::ExitCaseReport,
    Feature::ExitCaseHrConfirm,
    Feature::ExitCaseHqConfirm,
    Feature::ExitSettlementManage,
    Feature::EmployeeDirectoryManage,
];

pub struct World {
    pub hr: HrService,
    pub owner: PgPool,
    pub org: Uuid,
    pub ops: Principal,
}

pub async fn world(pool: PgPool) -> World {
    let (org, ops) = (OrgId::new(), UserId::new());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'own record')")
        .bind(*org.as_uuid())
        .bind(format!("own-{}", &org.as_uuid().simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    go_live::go_live(&pool, *org.as_uuid()).await;
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_tenant_ops) VALUES ($1, '운영', '{}', $2, true)",
    )
    .bind(*ops.as_uuid())
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
    let ops = Principal::new(
        ops,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_tenant_ops(true);
    World {
        hr: HrService::new(rt),
        owner: pool,
        org: *org.as_uuid(),
        ops,
    }
}

impl World {
    pub async fn employee(&self, name: &str) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO employees (org_id, company, name, position, job, source_filename, \
             source_sheet, source_row, source_key, hire_date) VALUES ($1, 'Co', $2, '사원', \
             '인사', 'console', 'console', 1, $3, '2025-01-02') RETURNING id",
        )
        .bind(self.org)
        .bind(name)
        .bind(Uuid::new_v4().to_string())
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    pub async fn link(&self, account: Uuid, employee: Uuid) {
        sqlx::query("UPDATE users SET employee_id = $3 WHERE org_id = $1 AND id = $2")
            .bind(self.org)
            .bind(account)
            .bind(employee)
            .execute(&self.owner)
            .await
            .unwrap();
    }

    /// An HR worker linked to their own employee record, holding every HR
    /// write tenant-wide (the projection BE-ROLES gives 인사 실무 over 법인).
    pub async fn hr_worker(&self) -> (Principal, Uuid) {
        let employee = self.employee("박인사").await;
        let account = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, org_id, employee_id) VALUES ($1, '박인사', '{}', $2, $3)",
        )
        .bind(account)
        .bind(self.org)
        .bind(employee)
        .execute(&self.owner)
        .await
        .unwrap();
        let grants = HR_FEATURES
            .iter()
            .map(|f| EffectiveFeatureGrant::new(*f, PermissionLevel::Allow, BranchScope::All))
            .collect();
        let principal = Principal::new(
            UserId::from_uuid(account),
            OrgId::from_uuid(self.org),
            BTreeSet::from([Role::Member]),
            BranchScope::All,
        )
        .with_effective_feature_grants(grants);
        (principal, employee)
    }

    /// A tenant-wide grant of a role with 퇴직 등록·수정 to `account`.
    pub async fn grant_exit_role(&self, account: Uuid) {
        let ops = *self.ops.user_id.as_uuid();
        let role: Uuid = sqlx::query_scalar(
            "INSERT INTO access_roles (org_id, name_ko, status, version, created_by) \
             VALUES ($1, '퇴직 담당', 'ACTIVE', 1, $2) RETURNING id",
        )
        .bind(self.org)
        .bind(ops)
        .fetch_one(&self.owner)
        .await
        .unwrap();
        for sql in [
            "INSERT INTO access_role_versions (org_id, role_id, version, name_ko, status, change_mode, created_by) \
             VALUES ($1, $2, 1, '퇴직 담당', 'ACTIVE', 'OPERATING', $3)",
            "INSERT INTO access_role_lines (org_id, role_id, version, domain, levels) \
             VALUES ($1, $2, 1, 'exit', ARRAY['view', 'edit'])",
        ] {
            sqlx::query(sql)
                .bind(self.org)
                .bind(role)
                .bind(ops)
                .execute(&self.owner)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO access_grants (org_id, account_id, role_id, scope_kind, valid_from, \
             change_mode, reason_code, granted_by) \
             VALUES ($1, $2, $3, 'TENANT', now() - interval '1 day', 'OPERATING', 'NEW_HIRE', $4)",
        )
        .bind(self.org)
        .bind(account)
        .bind(role)
        .bind(ops)
        .execute(&self.owner)
        .await
        .unwrap();
    }

    pub async fn report(&self, who: &Principal, employee: Uuid) -> Result<Uuid, HrError> {
        let body: ReportEmployeeExitCaseRequest = serde_json::from_value(json!({
            "employee_id": employee, "effective_exit_date": "2026-12-31",
            "site_manager_note": "본인 사정으로 퇴사", "exit_reason_code": "PERSONAL",
        }))
        .unwrap();
        let (_, case) = self
            .hr
            .report_exit_case(who.clone(), format!("own-{employee}"), body)
            .await?;
        Ok(case["id"].as_str().unwrap().parse().unwrap())
    }

    pub async fn count(&self, sql: &'static str, id: Uuid) -> i64 {
        sqlx::query_scalar(sql)
            .bind(id)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

pub fn confirm() -> ConfirmEmployeeExitCaseRequest {
    serde_json::from_value(json!({
        "signoffs": { "privacy_notice_ack": true, "korean_labor_law_ack": true,
                      "payroll_cutoff_ack": true, "retirement_settlement_ack": true },
    }))
    .unwrap()
}

pub fn close() -> CloseEmployeeExitCaseRequest {
    serde_json::from_value(json!({ "reason": "다시 확인" })).unwrap()
}

pub fn refused(result: Result<impl std::fmt::Debug, HrError>) -> (u16, &'static str, Value) {
    let err = result.unwrap_err();
    (
        err.status.as_u16(),
        err.code,
        err.refusals.unwrap_or_default(),
    )
}

pub const OWN: (u16, &str) = (403, "own_record_forbidden");
