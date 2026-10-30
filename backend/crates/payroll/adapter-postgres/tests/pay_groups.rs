// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::{ErrorKind, OrgId, UserId};
use console_payroll_adapter_postgres::{PgPayrollStore, pay_groups::CreatePayGroup};
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "../../rest/tests/fixtures/pay_view.rs"]
mod pay_access;

async fn entity(pool: &PgPool, org: OrgId) -> Uuid {
    // rls-arming: ok owner creates prerequisites; all pay-group calls use console_rt.
    sqlx::query_scalar("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION') RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4()).fetch_one(pool).await.unwrap()
}

fn input(entity: Uuid) -> CreatePayGroup {
    CreatePayGroup {
        legal_entity_id: entity,
        name: "모의상사 월급".into(),
        pay_date_rule: "근로계약 제4조: 매월 말일".into(),
        base_period: "당월 1일~말일".into(),
        variable_period: "전월 1일~말일".into(),
        proration: "근로계약 제4조: 해당 월 역일 기준".into(),
        channel: "근로자 지정 계좌".into(),
    }
}

async fn audit_count(pool: &PgPool, actor: UserId) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE actor=$1 AND action LIKE 'payroll.pay_group_%'",
    )
    .bind(actor.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_groups_preserve_explicit_rules_and_cedar_entity_visibility(pool: PgPool) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    let admin = seed_org_and_super_admin(&pool, *org.as_uuid(), "pay-groups").await;
    let a = entity(&pool, org).await;
    let b = entity(&pool, org).await;
    pay_access::grant_manage(&pool, org, admin, None).await;
    let rt = runtime_role_pool(&pool).await;
    let store = PgPayrollStore::new(rt);
    for entity in [a, b] {
        let expected = input(entity);
        let group = store
            .create_pay_group(org, admin, expected.clone())
            .await
            .unwrap();
        let mut actual = serde_json::to_value(&group).unwrap();
        actual.as_object_mut().unwrap().remove("id");
        assert_eq!(actual, serde_json::to_value(expected).unwrap());
    }
    assert_eq!(store.list_pay_groups(org, admin).await.unwrap().len(), 2);
    assert_eq!(audit_count(&pool, admin).await, 3);
    let reader = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "entity-pay-reader").await;
    let grant = pay_access::grant_view(&pool, org, reader, Some(a)).await;
    let groups = store.list_pay_groups(org, reader).await.unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].legal_entity_id, a);
    let denied = store
        .create_pay_group(org, reader, input(a))
        .await
        .unwrap_err();
    assert_eq!(denied.kind(), ErrorKind::Forbidden);
    assert_eq!(
        audit_count(&pool, reader).await,
        1,
        "refused creates cannot audit success"
    );
    // rls-arming: ok owner revokes the fixture grant between transactions.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(grant).execute(&pool).await.unwrap();
    assert_eq!(
        store.list_pay_groups(org, reader).await.unwrap_err().kind(),
        ErrorKind::Forbidden
    );
    assert_eq!(
        audit_count(&pool, reader).await,
        1,
        "revoked reads cannot audit success"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_creation_refuses_wrong_scope_unknown_entity_and_foreign_entity(pool: PgPool) {
    let a = OrgId::from_uuid(Uuid::new_v4());
    let b = OrgId::from_uuid(Uuid::new_v4());
    let actor = seed_org_and_super_admin(&pool, *a.as_uuid(), "pay-group-refusals").await;
    seed_org_and_super_admin(&pool, *b.as_uuid(), "foreign-pay-group").await;
    let allowed = entity(&pool, a).await;
    let outside_scope = entity(&pool, a).await;
    let foreign = entity(&pool, b).await;
    pay_access::grant_manage(&pool, a, actor, Some(allowed)).await;
    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    for target in [outside_scope, foreign, Uuid::new_v4()] {
        let error = store
            .create_pay_group(a, actor, input(target))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Forbidden);
    }
    let group = store
        .create_pay_group(a, actor, input(allowed))
        .await
        .unwrap();
    assert_eq!(
        store.list_pay_groups(a, actor).await.unwrap()[0].id,
        group.id
    );
    let tenant_reader = seed_active_user(&pool, *b.as_uuid(), "MEMBER", "foreign-pay-reader").await;
    pay_access::grant_view(&pool, b, tenant_reader, None).await;
    assert!(
        store
            .list_pay_groups(b, tenant_reader)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(audit_count(&pool, actor).await, 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_groups_refuse_legacy_titles_and_report_invalid_fields_without_persisting(
    pool: PgPool,
) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "explicit-pay-rules").await;
    let entity = entity(&pool, org).await;
    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    assert_eq!(
        store.list_pay_groups(org, actor).await.unwrap_err().kind(),
        ErrorKind::Forbidden
    );
    assert_eq!(
        store
            .create_pay_group(org, actor, input(entity))
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::Forbidden
    );
    pay_access::grant_manage(&pool, org, actor, None).await;
    for field in [
        "name",
        "pay_date_rule",
        "base_period",
        "variable_period",
        "proration",
        "channel",
    ] {
        for value in [" ".to_owned(), "가".repeat(201)] {
            let mut invalid = serde_json::to_value(input(entity)).unwrap();
            invalid[field] = json!(value);
            let error = store
                .create_pay_group(org, actor, serde_json::from_value(invalid).unwrap())
                .await
                .unwrap_err();
            assert_eq!(error.kind(), ErrorKind::Validation);
            let console_payroll_adapter_postgres::PgPayrollError::Domain(error) = error else {
                panic!("expected domain error")
            };
            assert_eq!(error.field.as_deref(), Some(field));
        }
        let mut missing = serde_json::to_value(input(entity)).unwrap();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<CreatePayGroup>(missing).is_err(),
            "{field} cannot default"
        );
    }
    assert_eq!(audit_count(&pool, actor).await, 0);
    assert!(store.list_pay_groups(org, actor).await.unwrap().is_empty());
}
