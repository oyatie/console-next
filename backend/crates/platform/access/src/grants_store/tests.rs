// SPDX-License-Identifier: LicenseRef-Proprietary
//! Regression proofs over an empty, migrated database; no grant ageing or sleeps.

use super::*;
use crate::dto::LineOut;
use crate::roles_store::{VersionFields, insert_head, insert_version};
use console_platform_authz::access::{Domain, Level, load_access_subject};
use sqlx::PgPool;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../db/migrations");

async fn fixture(pool: &PgPool) -> (OrgId, Uuid, Uuid, Uuid) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Grant delay test')")
        .bind(org.as_uuid())
        .bind(org.to_string())
        .execute(pool)
        .await
        .unwrap();
    let actor = Uuid::new_v4();
    let target = Uuid::new_v4();
    for (id, ops) in [(actor, true), (target, false)] {
        sqlx::query("INSERT INTO users (id, org_id, display_name, roles, is_tenant_ops) VALUES ($1, $2, 'Test holder', '{}', $3)")
            .bind(id).bind(org.as_uuid()).bind(ops).execute(pool).await.unwrap();
    }
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let role = Uuid::new_v4();
    let lines = [LineOut {
        domain: Domain::Org,
        levels: vec![Level::View, Level::Edit, Level::Approve],
    }];
    let fields = VersionFields {
        name_ko: "조직 결재",
        name_en: None,
        description: None,
        status: "ACTIVE",
        change_mode: "SETUP",
        reason_code: None,
        reason_note: None,
        lines: &lines,
    };
    insert_head(&mut tx, org, role, actor, &fields)
        .await
        .unwrap();
    insert_version(&mut tx, org, role, 1, actor, &fields)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    (org, actor, target, role)
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn sole_admin_elevated_grant_does_not_authorize_before_delay(pool: PgPool) {
    let (org, actor, target, role) = fixture(&pool).await;
    let now = OffsetDateTime::now_utc();
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
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
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
    let subject = load_access_subject(&mut tx, org, target, now)
        .await
        .unwrap();
    assert!(
        subject.grants.is_empty(),
        "pending elevated grants must authorize nothing"
    );
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn pending_grant_clock_cancellation_and_revocation_are_safe(pool: PgPool) {
    use console_kernel_core::FixedClock;
    let (org, actor, target, role) = fixture(&pool).await;
    let now = OffsetDateTime::now_utc();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
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
    assert!(due > now);
    let granted: i64 = sqlx::query_scalar("SELECT count(*) FROM authz_grant_ledger WHERE org_id=$1 AND grant_ref=$2 AND event='GRANTED'")
        .bind(org.as_uuid()).bind(row.id.to_string()).fetch_one(tx.as_mut()).await.unwrap();
    assert_eq!(granted, 0, "a pending grant has never held a capability");
    let error = crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(now))
        .await
        .unwrap_err();
    assert_eq!(error.code, "pending_grant_not_due");
    assert!(
        load_access_subject(&mut tx, org, target, due)
            .await
            .unwrap()
            .grants
            .is_empty()
    );
    crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(due))
        .await
        .unwrap();
    assert_eq!(
        load_access_subject(&mut tx, org, target, due)
            .await
            .unwrap()
            .grants
            .len(),
        1
    );
    revoke(&mut tx, org, row.id, actor).await.unwrap();
    assert_eq!(
        crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(due))
            .await
            .unwrap_err()
            .code,
        "grant_ended"
    );
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn cancelled_pending_grant_never_activates(pool: PgPool) {
    use console_kernel_core::FixedClock;
    let (org, actor, target, role) = fixture(&pool).await;
    let now = OffsetDateTime::now_utc();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
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
    revoke(&mut tx, org, row.id, actor).await.unwrap();
    let removals: i64 = sqlx::query_scalar("SELECT count(*) FROM authz_grant_ledger WHERE org_id=$1 AND grant_ref=$2 AND event IN ('GRANTED','REVOKED')")
        .bind(org.as_uuid()).bind(row.id.to_string()).fetch_one(tx.as_mut()).await.unwrap();
    assert_eq!(
        removals, 0,
        "cancelling a pending grant must not manufacture a demoted second person"
    );
    let due: OffsetDateTime = sqlx::query_scalar(
        "SELECT activates_at FROM user_role_grants_pending WHERE org_id=$1 AND grant_id=$2",
    )
    .bind(org.as_uuid())
    .bind(row.id)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(
        crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(due))
            .await
            .unwrap_err()
            .code,
        "grant_ended"
    );
    assert!(
        load_access_subject(&mut tx, org, target, due)
            .await
            .unwrap()
            .grants
            .is_empty()
    );
}

mod adversarial;
mod boundaries;
mod integrity;
