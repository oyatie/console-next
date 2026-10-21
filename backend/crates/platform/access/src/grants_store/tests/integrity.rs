// SPDX-License-Identifier: LicenseRef-Proprietary
//! Refusal and lockout properties with pending grants.
use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn pending_grant_rechecks_grantor_and_does_not_replace_the_last_ops_holder(pool: PgPool) {
    use console_kernel_core::FixedClock;
    let (org, actor, target, role) = fixture(&pool).await;
    let now = OffsetDateTime::now_utc();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let row = GrantRow {
        id: Uuid::new_v4(),
        account_id: target,
        role_id: role,
        kind: NodeKind::Tenant,
        node_id: None,
        valid_from: now,
        valid_to: None,
        revoked: false,
        effective_in_setup: true,
    };
    insert(
        &mut tx,
        org,
        &NewGrant {
            row: &row,
            change_mode: "SETUP",
            reason_code: "PROMOTION_OR_REASSIGNMENT",
            reason_note: None,
            granted_by: actor,
        },
    )
    .await
    .unwrap();
    let due: OffsetDateTime = sqlx::query_scalar(
        "SELECT activates_at FROM user_role_grants_pending WHERE org_id=$1 AND grant_id=$2",
    )
    .bind(org.as_uuid())
    .bind(row.id)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    // The pending target cannot stand in for the last ops account.
    sqlx::query("UPDATE users SET is_active=false WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(actor)
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(
        crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(due))
            .await
            .unwrap_err()
            .code,
        "access_denied"
    );
    let err = sqlx::query("SET CONSTRAINTS tenant_keeps_ops IMMEDIATE")
        .execute(tx.as_mut())
        .await
        .unwrap_err();
    assert_eq!(
        err.as_database_error().and_then(|e| e.constraint()),
        Some("tenant_keeps_ops")
    );
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn self_grant_and_grantor_ceiling_refusals_have_no_writes(pool: PgPool) {
    use crate::{actor::Actor, dto::ScopeIn, grant_types::Op};
    use console_kernel_core::{BranchScope, TenantPhase, UserId};
    use console_platform_authz::Principal;
    let (org, actor, target, role) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let p = Principal::new(
        UserId::from_uuid(actor),
        org,
        Default::default(),
        BranchScope::All,
    )
    .with_tenant_ops(true);
    let a = Actor::load(&mut tx, &p).await.unwrap();
    let now = OffsetDateTime::now_utc();
    let op = |id| Op::Grant {
        grant_id: Uuid::new_v4(),
        account_id: id,
        role_id: role,
        scope: ScopeIn {
            kind: "TENANT".into(),
            node_id: None,
            include_descendants: true,
        },
        valid_from: now,
        valid_to: None,
        effective_in_setup: true,
    };
    // A non-ops account is the self-grant target; the caller still holds the ops snapshot.
    sqlx::query("UPDATE users SET is_tenant_ops=false WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(actor)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let self_refused = crate::grant_ops::check(
        &mut tx,
        &a,
        TenantPhase::Operating,
        now,
        0,
        &op(actor),
        None,
    )
    .await
    .unwrap();
    assert_eq!(self_refused.item["refusal"]["code"], "self_grant_forbidden");
    let low = Principal::new(
        UserId::from_uuid(target),
        org,
        Default::default(),
        BranchScope::All,
    );
    let low = Actor::load(&mut tx, &low).await.unwrap();
    let path = low.tenant();
    let lines = [LineOut {
        domain: Domain::Org,
        levels: vec![Level::Approve],
    }];
    assert_eq!(
        low.require_holds(&lines, &path).unwrap_err().code,
        "grant_exceeds_grantor"
    );
    assert!(self_refused.write.is_none());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM access_grants WHERE org_id=$1")
        .bind(org.as_uuid())
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(count, 0);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn every_ops_removal_path_keeps_a_holder_even_with_a_pending_replacement(pool: PgPool) {
    for cancel in [false, true] {
        for mutation in [
            "UPDATE users SET is_active=false WHERE id=$1",
            "UPDATE users SET is_tenant_ops=false WHERE id=$1",
            "DELETE FROM users WHERE id=$1",
        ] {
            let (org, actor, target, role) = fixture(&pool).await;
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.current_org',$1,true)")
                .bind(org.to_string())
                .execute(tx.as_mut())
                .await
                .unwrap();
            let row = GrantRow {
                id: Uuid::new_v4(),
                account_id: target,
                role_id: role,
                kind: NodeKind::Tenant,
                node_id: None,
                valid_from: OffsetDateTime::now_utc(),
                valid_to: None,
                revoked: false,
                effective_in_setup: true,
            };
            insert(
                &mut tx,
                org,
                &NewGrant {
                    row: &row,
                    change_mode: "SETUP",
                    reason_code: "PROMOTION_OR_REASSIGNMENT",
                    reason_note: None,
                    granted_by: actor,
                },
            )
            .await
            .unwrap();
            let pending: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_role_grants_pending WHERE org_id=$1 AND grant_id=$2)")
                .bind(org.as_uuid()).bind(row.id).fetch_one(tx.as_mut()).await.unwrap();
            assert!(pending);
            if cancel {
                revoke(&mut tx, org, row.id, actor).await.unwrap();
            }
            tx.commit().await.unwrap();
            let mut tx = pool.begin().await.unwrap();
            // Delete may refuse immediately (grant FK), the other writes at commit.
            let write = sqlx::query(mutation).bind(actor).execute(tx.as_mut()).await;
            if write.is_ok() {
                assert!(tx.commit().await.is_err());
            } else {
                tx.rollback().await.unwrap();
            }
            let holders: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM users WHERE org_id=$1 AND is_tenant_ops AND is_active",
            )
            .bind(org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(holders, 1, "{mutation}, cancel={cancel}");
        }
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn pending_activation_refuses_a_grantor_who_lost_the_granted_capability(pool: PgPool) {
    use console_kernel_core::FixedClock;
    let (org, actor, target, role) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let row = GrantRow {
        id: Uuid::new_v4(),
        account_id: target,
        role_id: role,
        kind: NodeKind::Tenant,
        node_id: None,
        valid_from: OffsetDateTime::now_utc(),
        valid_to: None,
        revoked: false,
        effective_in_setup: true,
    };
    insert(
        &mut tx,
        org,
        &NewGrant {
            row: &row,
            change_mode: "SETUP",
            reason_code: "PROMOTION_OR_REASSIGNMENT",
            reason_note: None,
            granted_by: actor,
        },
    )
    .await
    .unwrap();
    let due: OffsetDateTime = sqlx::query_scalar(
        "SELECT activates_at FROM user_role_grants_pending WHERE org_id=$1 AND grant_id=$2",
    )
    .bind(org.as_uuid())
    .bind(row.id)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=false WHERE id=$1")
        .bind(actor)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id,org_id,display_name,roles,is_tenant_ops) VALUES ($1,$2,'후임 관리자','{}',true)")
        .bind(Uuid::new_v4()).bind(org.as_uuid()).execute(tx.as_mut()).await.unwrap();
    let error = crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(due))
        .await
        .unwrap_err();
    assert_eq!(error.code, "grant_exceeds_grantor");
    // Keeping the delegated capability does not replace lost authority to grant.
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by)
        SELECT $1,$2,$3,'TENANT',now(),true,'SETUP','PROMOTION_OR_REASSIGNMENT',id FROM users WHERE org_id=$1 AND is_tenant_ops")
        .bind(org.as_uuid()).bind(actor).bind(role).execute(tx.as_mut()).await.unwrap();
    let error = crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(due))
        .await
        .unwrap_err();
    assert_eq!(error.code, "access_denied");
    assert!(
        load_access_subject(&mut tx, org, target, due)
            .await
            .unwrap()
            .grants
            .is_empty()
    );
    tx.commit().await.unwrap();
}
