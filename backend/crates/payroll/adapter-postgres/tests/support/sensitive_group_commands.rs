// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_authz::{Feature, cedar_pbac::visible::load_facts};
use console_platform_db::with_org_conn;

async fn allowed(pool: &PgPool, org: OrgId, actor: UserId, action: Feature) -> Vec<Uuid> {
    with_org_conn::<_, _, console_payroll_adapter_postgres::PgPayrollError>(pool, org, move |tx| {
        Box::pin(async move {
            let facts = load_facts(tx, org, *actor.as_uuid()).await?;
            Ok(facts.visible_pay_groups(tx, action).await?)
        })
    })
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stored_sensitive_flag_controls_command_authority_not_just_read_authority(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "sensitive-command").await;
    let entity = entity(&pool, org).await;
    pay_access::grant_manage(&pool, org, actor, None).await;
    let rt = runtime_role_pool(&pool).await;
    let group = PgPayrollStore::new(rt.clone())
        .create_pay_group(org, actor, input(entity))
        .await
        .unwrap();
    assert_eq!(
        allowed(&rt, org, actor, Feature::PayrollRunManage).await,
        vec![group.id]
    );
    // rls-arming: ok owner changes stored sensitivity; callers never supply the decision's flag.
    sqlx::query("UPDATE pay_groups SET sensitive=true WHERE id=$1")
        .bind(group.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        allowed(&rt, org, actor, Feature::PayrollRunManage)
            .await
            .is_empty()
    );
    assert!(
        allowed(&rt, org, actor, Feature::PayrollRunRead)
            .await
            .is_empty()
    );
    pay_access::grant_sensitive(&pool, org, actor, Some(entity), "view").await;
    assert_eq!(
        allowed(&rt, org, actor, Feature::PayrollRunRead).await,
        vec![group.id]
    );
    assert!(
        allowed(&rt, org, actor, Feature::PayrollRunManage)
            .await
            .is_empty()
    );
    let clearance = pay_access::grant_sensitive(&pool, org, actor, Some(entity), "edit").await;
    assert_eq!(
        allowed(&rt, org, actor, Feature::PayrollRunManage).await,
        vec![group.id]
    );
    assert!(
        allowed(&rt, org, actor, Feature::EmployeeDirectoryManage)
            .await
            .is_empty()
    );
    // rls-arming: ok revoke edit without removing view, then reuse the same account.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(clearance).execute(&pool).await.unwrap();
    assert!(
        allowed(&rt, org, actor, Feature::PayrollRunManage)
            .await
            .is_empty()
    );
    assert_eq!(
        allowed(&rt, org, actor, Feature::PayrollRunRead).await,
        vec![group.id]
    );
    with_org_conn::<_, _, console_payroll_adapter_postgres::PgPayrollError>(&rt, org, move |tx| {
        Box::pin(async move {
            let facts = load_facts(tx, org, *actor.as_uuid()).await?;
            sqlx::query("RESET app.current_org")
                .execute(tx.as_mut())
                .await?;
            let refused = facts
                .visible_pay_groups(tx, Feature::PayrollRunRead)
                .await
                .unwrap_err();
            assert_eq!(refused.kind, ErrorKind::Forbidden);
            Ok(())
        })
    })
    .await
    .unwrap();
}
