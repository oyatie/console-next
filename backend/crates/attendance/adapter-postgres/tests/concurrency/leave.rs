// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

pub(super) async fn seed_approved_leave(
    pool: &PgPool,
    branch: BranchId,
    requester: UserId,
    decider: UserId,
    employee: Uuid,
) {
    for user in [requester, decider] {
        person_fixtures::bind_user_to_distinct_person(pool, user).await;
    }
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_leave_definer")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(OrgId::one().as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO leave_requests (id,org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status,decided_by,decided_at,charge_state,charge_review_reasons,charge_units) VALUES ($1,$2,$3,$4,$5,'annual',1,DATE '2026-07-02',DATE '2026-07-02','approved',$6,now(),'legacy_unverified',ARRAY[]::text[],1)",
    )
    .bind(Uuid::new_v4())
    .bind(*OrgId::one().as_uuid())
    .bind(*branch.as_uuid())
    .bind(*requester.as_uuid())
    .bind(employee)
    .bind(*decider.as_uuid())
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
}
