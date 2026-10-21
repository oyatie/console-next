// SPDX-License-Identifier: LicenseRef-Proprietary
//! Removing the other holder cannot manufacture the solo action path.
use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn revoking_the_other_holder_while_a_grant_waits_preserves_the_second_person(pool: PgPool) {
    use console_identity_adapter_postgres::second_person::{
        SecondPersonQuery, second_person_fact_in_tx,
    };
    use console_kernel_core::{FixedClock, UserId};
    use console_platform_authz::Feature;
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
    // A previously active holder is removed while the new grant is waiting.
    let other = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id,org_id,display_name,roles) VALUES ($1,$2,'기존 결재자','{}')",
    )
    .bind(other)
    .bind(org.as_uuid())
    .execute(tx.as_mut())
    .await
    .unwrap();
    let old: Uuid = sqlx::query_scalar("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by)
        VALUES ($1,$2,$3,'TENANT',now(),true,'SETUP','PROMOTION_OR_REASSIGNMENT',$4) RETURNING id")
        .bind(org.as_uuid()).bind(other).bind(role).bind(actor).fetch_one(tx.as_mut()).await.unwrap();
    revoke(&mut tx, org, old, actor).await.unwrap();
    crate::pending::activate_in_tx(&mut tx, org, row.id, &FixedClock(due))
        .await
        .unwrap();
    let fact = second_person_fact_in_tx(
        &mut tx,
        &SecondPersonQuery {
            org,
            feature: Feature::OrgChangeApprove,
            branch: None,
            requester: UserId::from_uuid(actor),
            excluded: vec![],
            case_created_at: now,
            min_grant_age_days: 7,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        fact.eligible,
        [other].into(),
        "the demotion guard still requires the other person"
    );
    assert!(
        !fact.eligible.contains(&target),
        "activation does not waive minimum grant age"
    );
    assert_eq!(fact.other_eligible_holders, 1);
    tx.commit().await.unwrap();
}
