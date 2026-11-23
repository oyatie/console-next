// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::access::{NodeKind, ScopeGrant};
use console_platform_authz::{Feature, Principal};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_domain::Governance;
use sqlx::PgPool;
use uuid::Uuid;

const RUNTIME_KEYS: &[&str] = &[
    "auth.idle_timeout_minutes",
    "approval.policy.org_structure",
    "approval.policy.people_correction",
    "approval.policy.identity_merge",
    "approval.policy.registration_void",
    "approval.policy.exit",
    "approval.policy.import_rollback",
    "hr.contract_soon_days",
    "display.deadline_due_soon_days",
    "display.experience",
    "onboarding.receipt_days",
    "period_lock.unlock_max_days",
];

async fn read_list(pool: &PgPool, principal: Principal, entity: Option<Uuid>) -> serde_json::Value {
    use axum::{Extension, extract::State, response::IntoResponse};
    let response = super::list(
        State(super::SettingsRestState::new(
            PgSettingsStore::new(runtime_role_pool(pool).await),
            None,
        )),
        Extension(principal),
        axum::extract::Query(super::ListQuery { entity }),
    )
    .await
    .unwrap()
    .into_response();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn assert_runtime_only(body: &serde_json::Value) {
    let mut keys: Vec<_> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["key"].as_str().unwrap())
        .collect();
    keys.sort_unstable();
    let mut expected = RUNTIME_KEYS.to_vec();
    expected.sort_unstable();
    assert_eq!(keys, expected);
    assert_eq!(body["can_change"], false);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn member_without_settings_grant_gets_only_runtime_keys(pool: PgPool) {
    let org = OrgId::new();
    seed_org_and_super_admin(&pool, *org.as_uuid(), "runtime-settings").await;
    let user =
        console_platform_test_support::seed_active_user(&pool, *org.as_uuid(), "MEMBER", "reader")
            .await;
    let principal = Principal::new(user, org, Default::default(), BranchScope::All);
    assert_runtime_only(&read_list(&pool, principal, None).await);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn settings_view_grant_reads_only_its_scope_and_revocation_takes_effect(pool: PgPool) {
    let org = OrgId::new();
    let maker = seed_org_and_super_admin(&pool, *org.as_uuid(), "scoped-settings").await;
    let user =
        console_platform_test_support::seed_active_user(&pool, *org.as_uuid(), "MEMBER", "reader")
            .await;
    let (entity, other, workplace, role) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    for id in [entity, other] {
        sqlx::query("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES($1,$2,true,'MIGRATION')")
            .bind(org.as_uuid()).bind(id).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO workplaces(org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES($1,$2,$3,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(workplace).bind(entity).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,'Settings reader','ACTIVE',1,$3)")
        .bind(org.as_uuid()).bind(role).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'Settings reader','ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'settings',ARRAY['view'])")
        .bind(org.as_uuid()).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,'LEGAL_ENTITY',$4,now()-interval '1 day',true,'SETUP','TEST',$5)")
        .bind(org.as_uuid()).bind(user.as_uuid()).bind(role).bind(entity).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    let principal = Principal::new(user, org, Default::default(), BranchScope::All);
    for scope in [entity, workplace] {
        let body = read_list(&pool, principal.clone(), Some(scope)).await;
        assert_eq!(
            body["items"].as_array().unwrap().len(),
            console_settings_domain::SettingKey::ALL.len()
        );
        assert_eq!(body["can_change"], false);
    }
    for scope in [None, Some(other)] {
        assert_runtime_only(&read_list(&pool, principal.clone(), scope).await);
    }
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE org_id=$1 AND account_id=$3")
        .bind(org.as_uuid()).bind(maker.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    assert_runtime_only(&read_list(&pool, principal, Some(workplace)).await);
    let ops = Principal::new(maker, org, Default::default(), BranchScope::All);
    assert_runtime_only(&read_list(&pool, ops.clone(), None).await);
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(maker.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        read_list(&pool, ops.with_tenant_ops(true), None).await["items"]
            .as_array()
            .unwrap()
            .len(),
        console_settings_domain::SettingKey::ALL.len()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn requested_scope_controls_capability_with_platform_first_or_empty_items(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "list-scope").await;
    let (entity, workplace) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO legal_entities(org_id,id,biz_kind,created_change_mode,created_by) VALUES($1,$2,'INDIVIDUAL','SETUP',$3)")
        .bind(org.as_uuid()).bind(entity).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO workplaces(org_id,id,legal_entity_id,needs_confirmation,created_change_mode,created_by) VALUES($1,$2,$3,true,'SETUP',$4)")
        .bind(org.as_uuid()).bind(workplace).bind(entity).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    let principal = Principal::new(actor, org, Default::default(), BranchScope::All)
        .with_scope_grants(vec![ScopeGrant {
            feature: Feature::SettingsManage,
            kind: NodeKind::LegalEntity,
            id: entity,
        }]);
    let store = PgSettingsStore::new(runtime_role_pool(&pool).await);
    for empty in [false, true] {
        let mut listed = store.list_effective(org, Some(workplace)).await.unwrap();
        assert_eq!(listed.resource_entities, vec![workplace, entity]);
        listed
            .items
            .sort_by_key(|item| item.governance != Governance::PlatformOnly);
        assert!(
            listed.items[0]
                .chain
                .iter()
                .all(|layer| layer.source.scope_entity_id.is_none())
        );
        if empty {
            listed.items.clear();
        }
        assert_eq!(
            super::list_response(&principal, listed).0["can_change"],
            true
        );
    }
}
