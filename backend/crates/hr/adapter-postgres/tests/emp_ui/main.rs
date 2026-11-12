#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BE-EMP-UI through the `HrService` entry points on a `console_rt` pool (RLS
//! armed): the catalog writes, the exit report's exit reason, dated bulk
//! promotion · contract renewal with its preview and batch undo, personnel
//! order notices, migration review and the per-field bulk-correction refusals.
//! Every guarded path has its refusal test (status, code, nothing written,
//! audit row present or absent); tests named `regression_*` fail on the parent
//! commit 3c988fc2.

mod batch_access;
mod bulk;
mod catalog;
#[path = "../support/lifecycle_grant.rs"]
mod lifecycle_grant;
// --- lane: CRUD ---
mod crud_ends;
mod exit_reason;
#[path = "../support/go_live.rs"]
mod go_live;
mod notices;
mod preflight_access;
mod roster_fields;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_kernel_core::{BranchId, BranchScope, OrgId, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

pub struct Fixture {
    pub hr: HrService,
    pub owner: PgPool,
    /// The tenant ops account as trunk models it (org-wide, every door).
    pub ops: Principal,
    pub org: Uuid,
    pub user: Uuid,
}

pub async fn fixture(pool: PgPool, operating: bool) -> Fixture {
    let (org, user) = (OrgId::new(), UserId::new());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'EMP-UI org')")
        .bind(*org.as_uuid())
        .bind(format!(
            "empui-{}",
            &org.as_uuid().simple().to_string()[..12]
        ))
        .execute(&pool)
        .await
        .unwrap();
    if operating {
        go_live::go_live(&pool, *org.as_uuid()).await;
    }
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', $2, $3)")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"])
        .bind(*org.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    lifecycle_grant::grant(&pool, *org.as_uuid(), *user.as_uuid()).await;
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) SELECT org_id,role_id,1,'hr_basic',ARRAY['view','edit'] FROM access_grants WHERE org_id=$1 AND account_id=$2")
        .bind(org.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
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
        user,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    Fixture {
        hr: HrService::new(rt),
        owner: pool,
        ops,
        org: *org.as_uuid(),
        user: *user.as_uuid(),
    }
}

impl Fixture {
    /// Another signed-in user of this tenant holding only `roles`, org-wide.
    pub async fn other(&self, roles: &[Role], scope: BranchScope) -> Principal {
        let user = UserId::new();
        let names: Vec<&str> = roles.iter().map(|r| r.as_str()).collect();
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'U', $2, $3)")
            .bind(*user.as_uuid())
            .bind(&names)
            .bind(self.org)
            .execute(&self.owner)
            .await
            .unwrap();
        Principal::new(
            user,
            OrgId::from_uuid(self.org),
            roles.iter().copied().collect(),
            scope,
        )
    }

    /// A tenant-role holder: no built-in authority, one projected grant (the
    /// shape BE-ROLES's grant projection gives).
    pub async fn granted(&self, feature: Feature, scope: BranchScope) -> Principal {
        let principal = self.other(&[Role::Member], BranchScope::All).await;
        principal.with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            feature,
            PermissionLevel::Allow,
            scope,
        )])
    }

    /// An ACTIVE employee hired 2025-01-02 with no profile.
    pub async fn employee(&self) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO employees (org_id, company, name, position, job, source_filename, \
             source_sheet, source_row, source_key, hire_date) VALUES ($1, 'Co', '한결', '사원', \
             '생산', 'console', 'console', 1, $2, '2025-01-02') RETURNING id",
        )
        .bind(self.org)
        .bind(Uuid::new_v4().to_string())
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    pub async fn audits(&self, action: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = $2")
            .bind(self.org)
            .bind(action)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }

    pub async fn count(&self, table: &str) -> i64 {
        // Test-only: `table` is a literal at every call site.
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT count(*) FROM {table} WHERE org_id = $1"
        )))
        .bind(self.org)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }
}

/// A branch scope that is not the whole tenant.
pub fn one_branch() -> BranchScope {
    BranchScope::single(BranchId::new())
}

pub fn status(error: &console_hr_adapter_postgres::HrError) -> (u16, &'static str) {
    (error.status.as_u16(), error.code)
}

pub fn uuid(value: &serde_json::Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}
