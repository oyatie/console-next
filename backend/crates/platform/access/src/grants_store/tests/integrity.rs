// SPDX-License-Identifier: LicenseRef-Proprietary
//! Refusal and lockout properties with pending grants.
use super::*;

async fn pending_grant(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    actor: Uuid,
    target: Uuid,
    role: Uuid,
    kind: NodeKind,
    node_id: Option<Uuid>,
) -> (Uuid, OffsetDateTime) {
    let row = GrantRow {
        id: Uuid::new_v4(),
        account_id: target,
        role_id: role,
        kind,
        node_id,
        valid_from: OffsetDateTime::now_utc(),
        valid_to: None,
        revoked: false,
        effective_in_setup: true,
    };
    insert(
        tx,
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
    let due = sqlx::query_scalar(
        "SELECT activates_at FROM user_role_grants_pending WHERE org_id=$1 AND grant_id=$2",
    )
    .bind(org.as_uuid())
    .bind(row.id)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    (row.id, due)
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn pending_worker_activation_emits_access_topics_once_at_the_deadline(pool: PgPool) {
    use console_kernel_core::FixedClock;
    let (org, actor, target, role) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let (grant, due) =
        pending_grant(&mut tx, org, actor, target, role, NodeKind::Tenant, None).await;
    tx.commit().await.unwrap();
    let topics = || async {
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT c.resource_type, c.resource_id FROM resource_changes c
             JOIN audit_events a ON a.id=c.audit_event_id
             WHERE c.org_id=$1 AND a.target_id=$2 AND a.action='access.grant.activated'
             ORDER BY c.resource_type",
        )
        .bind(org.as_uuid())
        .bind(grant.to_string())
        .fetch_all(&pool)
        .await
        .unwrap()
    };
    assert_eq!(
        crate::pending::activate_due(&pool, &FixedClock(due - time::Duration::nanoseconds(1)))
            .await
            .unwrap(),
        0
    );
    assert!(topics().await.is_empty());
    assert_eq!(
        crate::pending::activate_due(&pool, &FixedClock(due))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        crate::pending::activate_due(&pool, &FixedClock(due))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        topics().await,
        [("role".into(), None), ("user".into(), None)]
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn pending_activation_refuses_an_inactive_target(pool: PgPool) {
    use console_kernel_core::FixedClock;
    let (org, actor, target, role) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let (grant, due) =
        pending_grant(&mut tx, org, actor, target, role, NodeKind::Tenant, None).await;
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(target)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error = crate::pending::activate_in_tx(&mut tx, org, grant, &FixedClock(due))
        .await
        .unwrap_err();
    assert_eq!(error.code, "grant_ended");
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn pending_activation_refuses_when_no_active_ops_holder_remains(pool: PgPool) {
    use console_kernel_core::FixedClock;
    let (org, actor, target, role) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let (grant, due) =
        pending_grant(&mut tx, org, actor, target, role, NodeKind::Tenant, None).await;
    sqlx::query("UPDATE users SET is_tenant_ops=false WHERE id=$1")
        .bind(actor)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error = crate::pending::activate_in_tx(&mut tx, org, grant, &FixedClock(due))
        .await
        .unwrap_err();
    assert_eq!(error.code, "access_denied");
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn pending_activation_refuses_an_inactive_grantor_with_another_ops_holder(pool: PgPool) {
    use console_kernel_core::FixedClock;
    for active in [true, false] {
        let (org, actor, target, role) = fixture(&pool).await;
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let (grant, due) =
            pending_grant(&mut tx, org, actor, target, role, NodeKind::Tenant, None).await;
        // The grantor retains Org and Access authority, so only the active-account guard can refuse.
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'access','{view,edit}')")
        .bind(org.as_uuid()).bind(role).execute(tx.as_mut()).await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=false WHERE id=$1")
            .bind(actor)
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id,org_id,display_name,roles,is_tenant_ops) VALUES ($1,$2,'후임 관리자','{}',true)")
        .bind(Uuid::new_v4())
        .bind(org.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
        sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by)
            SELECT $1,$2,$3,'TENANT',now(),true,'SETUP','PROMOTION_OR_REASSIGNMENT',id FROM users WHERE org_id=$1 AND is_tenant_ops")
            .bind(org.as_uuid()).bind(actor).bind(role).execute(tx.as_mut()).await.unwrap();
        sqlx::query("UPDATE users SET is_active=$2 WHERE id=$1")
            .bind(actor)
            .bind(active)
            .execute(tx.as_mut())
            .await
            .unwrap();
        let result = crate::pending::activate_in_tx(&mut tx, org, grant, &FixedClock(due)).await;
        assert_eq!(
            load_access_subject(&mut tx, org, target, due)
                .await
                .unwrap()
                .grants
                .len(),
            usize::from(active)
        );
        let activated: bool = sqlx::query_scalar("SELECT activated_at IS NOT NULL FROM user_role_grants_pending WHERE org_id=$1 AND grant_id=$2")
        .bind(org.as_uuid()).bind(grant).fetch_one(tx.as_mut()).await.unwrap();
        assert_eq!(activated, active);
        if active {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err().code, "access_denied");
        }
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn pending_activation_refuses_a_scope_closed_while_waiting(pool: PgPool) {
    use console_kernel_core::FixedClock;
    let (org, actor, target, role) = fixture(&pool).await;
    let entity = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(org.as_uuid())
        .bind(entity)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let (grant, due) = pending_grant(
        &mut tx,
        org,
        actor,
        target,
        role,
        NodeKind::LegalEntity,
        Some(entity),
    )
    .await;
    sqlx::query("UPDATE legal_entities SET closed_on=CURRENT_DATE,close_reason_code='DISSOLVED' WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(entity)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error = crate::pending::activate_in_tx(&mut tx, org, grant, &FixedClock(due))
        .await
        .unwrap_err();
    assert_eq!(error.code, "scope_node_closed");
    tx.rollback().await.unwrap();
}

mod authority;
