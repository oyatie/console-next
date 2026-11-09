// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "../../../../test-support/org_change_fixtures.rs"]
mod org_change_fixtures;
#[path = "../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

use console_kernel_core::{OrgId, UserId};
use console_orgchange_adapter_postgres::sole_holder_eligibility_in_tx;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use sqlx::PgPool;
use uuid::Uuid;

async fn fixture(pool: &PgPool) -> (OrgId, UserId, Uuid, [Uuid; 4]) {
    fixture_with_route(pool, true).await
}

async fn fixture_with_route(pool: &PgPool, routed: bool) -> (OrgId, UserId, Uuid, [Uuid; 4]) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(pool, *org.as_uuid(), "solo-eligibility").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    person_fixtures::bind_user_to_distinct_person(pool, actor).await;
    if routed {
        sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'approval.policy.org_structure','\"route\"',$2,'TEST')")
        .bind(org.as_uuid()).bind(actor.as_uuid()).execute(pool).await.unwrap();
    }
    let id = sqlx::query_scalar("INSERT INTO org_change_requests(org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES($1,'OC-2026-0001','REORG','IN_APPROVAL','REGION','region','Region',CURRENT_DATE,'Review','[]',$2,$3,repeat('a',64)) RETURNING id")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    let mut steps = [Uuid::nil(); 4];
    for (index, step) in steps.iter_mut().enumerate() {
        *step = sqlx::query_scalar("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) VALUES($1,$2,$3,'hr') RETURNING id")
            .bind(org.as_uuid()).bind(id).bind(i16::try_from(index+1).unwrap()).fetch_one(pool).await.unwrap();
    }
    (org, actor, id, steps)
}

async fn eligible(pool: &PgPool, org: OrgId, actor: UserId, id: Uuid) -> Option<Uuid> {
    let runtime = runtime_role_pool(pool).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sole_holder_eligibility_in_tx(&mut tx, org, actor, id)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_and_operating_solo_offer_only_first_pending_stored_step(pool: PgPool) {
    let (org, actor, id, steps) = fixture(&pool).await;
    let (_, _, foreign, _) = fixture(&pool).await;
    assert_eq!(eligible(&pool, org, actor, foreign).await, None);
    for phase in ["SETUP", "OPERATING"] {
        sqlx::query("INSERT INTO tenant_phase(org_id,phase) VALUES($1,$2) ON CONFLICT(org_id) DO UPDATE SET phase=$2")
            .bind(org.as_uuid()).bind(phase).execute(&pool).await.unwrap();
        assert_eq!(eligible(&pool, org, actor, id).await, Some(steps[0]));
    }
    for (index, step) in steps.iter().enumerate() {
        assert_eq!(eligible(&pool, org, actor, id).await, Some(*step));
        sqlx::query("UPDATE org_change_approval_steps SET decision='APPROVED',decided_by=$2,decided_at=now() WHERE id=$1")
            .bind(step).bind(actor.as_uuid()).execute(&pool).await.unwrap();
        assert_eq!(
            eligible(&pool, org, actor, id).await,
            steps.get(index + 1).copied()
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn policy_route_status_and_verified_identities_are_required(pool: PgPool) {
    let (org, actor, id, _) = fixture(&pool).await;
    let (unrouted_org, unrouted_actor, unrouted, _) = fixture_with_route(&pool, false).await;
    assert_eq!(
        eligible(&pool, unrouted_org, unrouted_actor, unrouted).await,
        None
    );
    {
        let (key, value) = ("authz.sole_holder.mode", "refuse");
        let (org, actor, id, steps) = fixture(&pool).await;
        sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code,effective_from) VALUES($1,$2,$3,$4,'TEST',now()+interval '1 hour')")
            .bind(org.as_uuid()).bind(key).bind(serde_json::json!(value)).bind(actor.as_uuid()).execute(&pool).await.unwrap();
        assert_eq!(
            eligible(&pool, org, actor, id).await,
            Some(steps[0]),
            "future policy"
        );
        sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,$2,$3,$4,'TEST')")
            .bind(org.as_uuid()).bind(key).bind(serde_json::json!(value)).bind(actor.as_uuid()).execute(&pool).await.unwrap();
        assert_eq!(eligible(&pool, org, actor, id).await, None);
    }
    for status in ["DRAFT", "APPROVED", "REJECTED", "CANCELLED"] {
        let (org, actor, id, _) = fixture(&pool).await;
        sqlx::query("UPDATE org_change_requests SET status=$2 WHERE id=$1")
            .bind(id)
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(eligible(&pool, org, actor, id).await, None);
    }
    sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,'ACCOUNT',$2,'NUMBER_BIRTH_AMBIGUOUS','{}')")
        .bind(org.as_uuid()).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    assert_eq!(eligible(&pool, org, actor, id).await, None);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn independent_live_holders_block_but_aliases_and_expired_grants_do_not(pool: PgPool) {
    let (org, actor, id, steps) = fixture(&pool).await;
    let person: Uuid = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(actor.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    let alias = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "alias").await;
    person_fixtures::bind_user_to_person(&pool, alias, person).await;
    org_change_fixtures::grant_org_approve(&pool, alias).await;
    assert_eq!(eligible(&pool, org, actor, id).await, Some(steps[0]));
    let other = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "other").await;
    org_change_fixtures::grant_org_approve(&pool, other).await;
    assert_eq!(
        eligible(&pool, org, actor, id).await,
        None,
        "unavailable identity fails closed"
    );
    person_fixtures::bind_user_to_distinct_person(&pool, other).await;
    assert_eq!(eligible(&pool, org, actor, id).await, None);
    assert_eq!(
        eligible(&pool, org, other, id).await,
        None,
        "ordinary checker gets no exception"
    );
    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE account_id=$1")
        .bind(other.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(eligible(&pool, org, actor, id).await, Some(steps[0]));
    assert_eq!(eligible(&pool, org, alias, id).await, Some(steps[0]));
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE account_id=$1")
        .bind(alias.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        eligible(&pool, org, alias, id).await,
        None,
        "lost authority"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn revoked_future_inactive_and_setup_ineffective_holders_do_not_block(pool: PgPool) {
    for case in ["revoked", "future", "inactive", "not_setup"] {
        let (org, actor, id, steps) = fixture(&pool).await;
        let other = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "other").await;
        person_fixtures::bind_user_to_distinct_person(&pool, other).await;
        org_change_fixtures::grant_org_approve(&pool, other).await;
        assert_eq!(eligible(&pool, org, actor, id).await, None);
        if case == "inactive" {
            sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
                .bind(other.as_uuid())
                .execute(&pool)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE account_id=$1")
                .bind(other.as_uuid()).execute(&pool).await.unwrap();
            if case != "revoked" {
                sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT org_id,account_id,role_id,scope_kind,now()+CASE WHEN $2 THEN interval '1 day' ELSE interval '0' END,$2,'SETUP','TEST',granted_by FROM access_grants WHERE account_id=$1")
                    .bind(other.as_uuid()).bind(case == "future").execute(&pool).await.unwrap();
            }
        }
        assert_eq!(
            eligible(&pool, org, actor, id).await,
            Some(steps[0]),
            "{case}"
        );
    }
}
