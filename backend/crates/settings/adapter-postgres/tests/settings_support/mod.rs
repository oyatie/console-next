// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code)]
use console_kernel_core::{AuditRequestContext, KernelError, OrgId, TraceContext};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use console_settings_adapter_postgres::{PgSettingsError, PgSettingsStore};
use console_settings_application::{Actor, ChangeSetting};
use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;
pub const KEY: &str = "approval.delegation.max_days"; // 1..=90, default 30, higher is looser

pub fn audit() -> (TraceContext, AuditRequestContext) {
    (TraceContext::generate(), AuditRequestContext::default())
}

pub fn change(value: Value, effective_from: Option<OffsetDateTime>) -> ChangeSetting {
    ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value,
        effective_from,
        reason_code: "POLICY_REVIEW".to_owned(),
        reason_note: Some("quarterly review".to_owned()),
        expected_version: None,
        step_up_assertion_id: None,
    }
}

pub async fn tenant(pool: &PgPool) -> (Actor, PgSettingsStore) {
    let org = Uuid::new_v4();
    let user = seed_org_and_super_admin(pool, org, "settings").await;
    let actor = Actor {
        org: OrgId::from_uuid(org),
        user,
    };
    (actor, PgSettingsStore::new(runtime_role_pool(pool).await))
}

pub async fn hire_someone(pool: &PgPool, org: OrgId) {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, source_key, raw_row, source_metadata) VALUES ($1, $2, 'test', 'someone', 'test.xlsx', 'employees', 1, $3, '{}', '{}')",
    )
    .bind(id)
    .bind(org.as_uuid())
    .bind(format!("settings-{id}"))
    // rls-arming: ok test fixture seeds as owner during setup
    .execute(pool)
    .await
    .unwrap();
}

pub fn err_code(err: &PgSettingsError) -> &'static str {
    match err {
        PgSettingsError::Domain(KernelError { code: Some(c), .. })
        | PgSettingsError::TooSoon {
            error: KernelError { code: Some(c), .. },
            ..
        }
        | PgSettingsError::Stale {
            error: KernelError { code: Some(c), .. },
            ..
        } => c,
        other => panic!("expected a coded refusal, got {other:?}"),
    }
}

pub fn code(result: Result<impl std::fmt::Debug, PgSettingsError>) -> &'static str {
    match result {
        Err(err) => err_code(&err),
        other => panic!("expected a coded refusal, got {other:?}"),
    }
}
