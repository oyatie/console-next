// SPDX-License-Identifier: LicenseRef-Proprietary
//! Shared request facts must preserve each source's independently loaded answer.
use super::*;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::access::{load_access_subject, project};
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use std::sync::Arc;
use uuid::Uuid;

async fn sources(pool: &PgPool, org: OrgId, actor: UserId) -> PgActionInboxSources {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let subject = load_access_subject(&mut tx, org, *actor.as_uuid(), OffsetDateTime::now_utc())
        .await
        .unwrap();
    let projection = project(&subject);
    assert!(projection.errors.is_empty());
    let principal = Principal::new(actor, org, Default::default(), BranchScope::All)
        .with_scope_grants(projection.scoped)
        .with_effective_feature_grants(projection.grants)
        .with_tenant_ops(subject.is_ops);
    let (deadline_due_soon_days, org_policy) =
        policy::load(tx.as_mut(), org, OffsetDateTime::now_utc())
            .await
            .unwrap();
    PgActionInboxSources {
        pool: pool.clone(),
        principal,
        authorization: Default::default(),
        setup: Default::default(),
        support_can_approve: Default::default(),
        privacy_can_handle: Default::default(),
        statutory_register: Default::default(),
        setup_created_at: OffsetDateTime::UNIX_EPOCH,
        deadline_due_soon_days,
        org_policy,
        read_permits: Arc::new(tokio::sync::Semaphore::new(1)),
        support_reference: String::new(),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_source_preserves_independent_authorization_and_next_request_revocation(
    pool: PgPool,
) {
    let org = OrgId::new();
    console_platform_request_context::scope_org(org, check_sources(pool, org)).await;
}

async fn check_sources(pool: PgPool, org: OrgId) {
    let ops = seed_org_and_super_admin(&pool, *org.as_uuid(), "authorization").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(ops.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let member = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "reader").await;
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'업무 담당','ACTIVE',1,$3)")
        .bind(org.as_uuid()).bind(role).bind(ops.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'업무 담당','ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(ops.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view','edit']),($1,$2,1,'pay',ARRAY['view','edit','approve'])")
        .bind(org.as_uuid()).bind(role).execute(&pool).await.unwrap();
    let grant = Uuid::new_v4();
    sqlx::query("INSERT INTO access_grants (org_id,id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,$4,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$5)")
        .bind(org.as_uuid()).bind(grant).bind(member.as_uuid()).bind(role).bind(ops.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES ($1,'회사','직원','console','console',1,'authorization')")
        .bind(org.as_uuid()).execute(&pool).await.unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut support = sources(&runtime, org, ops).await;
    support.principal = Principal::new(UserId::new(), org, Default::default(), BranchScope::All);
    support.principal.support = Some(
        serde_json::from_value(serde_json::json!({
            "active": true, "org_id": org.as_uuid(), "operator_approved": true,
            "tenant_approved": true, "session_id": Uuid::new_v4(),
            "operator_label": "지원 담당자", "scope": ["org"], "reveal_classes": []
        }))
        .unwrap(),
    );
    let support_page = support
        .list_source_page(
            ActionInboxSource::RegistrationChecks,
            ActionInboxSourceQuery {
                filter: InboxFilter::All,
                require_exact_total: true,
                now,
                as_of: now,
                after: None,
                limit: 20,
            },
        )
        .await
        .expect("support session reads do not require a tenant account");
    assert!(support_page.items.is_empty());
    for (actor, revoke) in [(ops, false), (member, false), (member, true)] {
        if revoke {
            sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE org_id=$1 AND id=$2")
                .bind(org.as_uuid())
                .bind(grant)
                .execute(&pool)
                .await
                .unwrap();
        }
        let shared = sources(&runtime, org, actor).await;
        for source in ActionInboxSource::ALL {
            let independent = sources(&runtime, org, actor).await;
            let query = ActionInboxSourceQuery {
                filter: InboxFilter::All,
                require_exact_total: true,
                now,
                as_of: now,
                after: None,
                limit: 20,
            };
            let expected = independent
                .list_source_page(source, query.clone())
                .await
                .unwrap_or_else(|error| panic!("independent {source:?}: {error}"));
            let actual = shared
                .list_source_page(source, query)
                .await
                .unwrap_or_else(|error| panic!("shared {source:?}: {error}"));
            assert_eq!(actual, expected, "{source:?}, revoked={revoke}");
            if source == ActionInboxSource::HrRegister && actor == member {
                assert_eq!(actual.total, usize::from(!revoke));
            }
        }
        let mut tx = runtime.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let facts = shared
            .authorization
            .get_in(&mut tx, org, *actor.as_uuid())
            .await
            .unwrap();
        let independent =
            console_platform_authz::cedar_pbac::visible::load_facts(&mut tx, org, *actor.as_uuid())
                .await
                .unwrap();
        for feature in console_platform_authz::Feature::ALL {
            assert_eq!(
                facts.permitted_nodes(feature.as_str()),
                independent.permitted_nodes(feature.as_str()),
                "{feature:?}, revoked={revoke}"
            );
        }
        let repeated = shared
            .authorization
            .get_in(&mut tx, org, *actor.as_uuid())
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&facts, &repeated));
        assert!(
            shared
                .authorization
                .get_in(&mut tx, OrgId::new(), *actor.as_uuid())
                .await
                .is_err()
        );
        assert!(
            shared
                .authorization
                .get_in(&mut tx, org, Uuid::new_v4())
                .await
                .is_err()
        );
        assert!(
            facts
                .access_permissions(OrgId::new(), *actor.as_uuid())
                .is_err()
        );
        assert!(facts.access_permissions(org, Uuid::new_v4()).is_err());
    }
    let failed = Authorization::default();
    sqlx::query("UPDATE users SET is_active=false WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(member.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error = failed
        .get_in(&mut tx, org, *member.as_uuid())
        .await
        .unwrap_err();
    assert_eq!(error.kind, console_kernel_core::ErrorKind::Forbidden);
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE users SET is_active=true WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(member.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(
        failed
            .get_in(&mut tx, org, *member.as_uuid())
            .await
            .unwrap_err(),
        error
    );
    assert!(
        Authorization::default()
            .get_in(&mut tx, org, *member.as_uuid())
            .await
            .is_ok()
    );
}
