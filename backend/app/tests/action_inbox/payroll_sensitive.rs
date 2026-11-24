// SPDX-License-Identifier: LicenseRef-Proprietary
//! A submitted run of a sensitive pay group reaches only approvers cleared to act
//! on it; to anyone else it would open as a run that does not exist.
use super::super::*;
use super::pay_view;

async fn seed_submitted_sensitive_run(pool: &PgPool, org: OrgId, submitter: UserId) -> uuid::Uuid {
    // rls-arming: ok owner seeds the group's legal entity; inbox reads use console_rt.
    let entity: uuid::Uuid = sqlx::query_scalar("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,gen_random_uuid(),true,'MIGRATION') RETURNING id")
        .bind(org.as_uuid()).fetch_one(pool).await.unwrap();
    // rls-arming: ok owner seeds a sensitive pay group.
    let group: uuid::Uuid = sqlx::query_scalar("INSERT INTO pay_groups (org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel,sensitive,pay_basis_allowed) VALUES ($1,gen_random_uuid(),$2,'Executive pay','{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}','{\"start_day\":\"FIRST\",\"month_offset\":0}','{\"start_day\":16,\"month_offset\":-1}','CALENDAR_DAYS','ATTESTATION_ONLY',true,ARRAY['MONTHLY']) RETURNING id")
        .bind(org.as_uuid()).bind(entity).fetch_one(pool).await.unwrap();
    // rls-arming: ok owner seeds the group's run as already submitted for decision.
    sqlx::query_scalar("INSERT INTO payroll_draft_runs (org_id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label,status,submitted_by,submitted_at) VALUES ($1,$2,'REGULAR',DATE '2026-07-01',DATE '2026-07-31',DATE '2026-07-01',DATE '2026-07-31',DATE '2026-06-16',DATE '2026-07-15','inbox-sensitive-run','SUBMITTED',$3,now()-interval '1 minute') RETURNING id")
        .bind(org.as_uuid()).bind(group).bind(submitter.as_uuid()).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_sensitive_run_awaiting_decision_is_left_out_of_an_inbox_without_clearance(pool: PgPool) {
    let (org, keys) = (OrgId::one(), keys());
    let branch = seed_branch(&pool, org, "Payroll region", "Payroll branch").await;
    let [submitter, cleared, viewer, uncleared] = [(); 4].map(|()| UserId::new());
    for user in [submitter, cleared, viewer, uncleared] {
        seed_user(&pool, org, user, "EXECUTIVE", branch).await;
        pay_view::grant_manage(&pool, org, user, None).await;
    }
    pay_view::grant_sensitive(&pool, org, cleared, None, "edit").await;
    // Cleared to read the run but not to decide it: the item would open to a 403.
    pay_view::grant_sensitive(&pool, org, viewer, None, "view").await;
    let run = seed_submitted_sensitive_run(&pool, org, submitter).await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let mut seen = Vec::new();
    for approver in [cleared, viewer, uncleared] {
        let token = bearer(&pool, &keys, org, approver, "EXECUTIVE", branch).await;
        let response = get(service.clone(), PATH, &token).await;
        assert_eq!(response.status, StatusCode::OK, "{:?}", response.json);
        seen.push(payroll_ids(&response.json));
    }
    assert_eq!(
        seen,
        [vec![format!("payroll:{run}")], Vec::new(), Vec::new()]
    );
}
