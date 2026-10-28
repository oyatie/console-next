// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::access::{NodeKind, ScopeGrant};
use console_platform_authz::{Feature, Principal};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_domain::Governance;
use sqlx::PgPool;
use uuid::Uuid;

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
