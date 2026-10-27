// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{http, person_fixtures};
use ::http::StatusCode;
use console_kernel_core::UserId;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn request(pool: &PgPool, org: Uuid, maker: UserId) -> (Uuid, [Uuid; 2]) {
    let id: Uuid = sqlx::query_scalar("INSERT INTO org_change_requests (org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,'OC-2026-0001','REORG','IN_APPROVAL','REGION','region','Region',CURRENT_DATE,'Review','[]',$2,$3,repeat('a',64)) RETURNING id")
        .bind(org).bind(maker.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    let mut steps = [Uuid::nil(); 2];
    for (index, step) in steps.iter_mut().enumerate() {
        *step = sqlx::query_scalar("INSERT INTO org_change_approval_steps (org_id,request_id,step_order,role_key) VALUES ($1,$2,$3,'hr') RETURNING id")
            .bind(org).bind(id).bind(i16::try_from(index + 1).unwrap()).fetch_one(pool).await.unwrap();
    }
    (id, steps)
}

pub(super) async fn actor(pool: &PgPool, org: Uuid) -> UserId {
    let user = http::add_user(pool, org, &["EXECUTIVE"]).await;
    person_fixtures::bind_user_to_distinct_person(pool, user).await;
    super::org_change_fixtures::grant_org_approve(pool, user).await;
    user
}

pub(super) async fn snapshot(pool: &PgPool, id: Uuid) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array(to_jsonb(r), (SELECT jsonb_agg(to_jsonb(s) ORDER BY step_order) FROM org_change_approval_steps s WHERE request_id=r.id), (SELECT count(*) FROM gov_approvals), (SELECT count(*) FROM org_change_events), (SELECT count(*) FROM audit_events WHERE action='org_change.step.decide')) FROM org_change_requests r WHERE id=$1")
        .bind(id).fetch_one(pool).await.unwrap()
}

pub(super) fn path(id: Uuid, step: Uuid) -> String {
    format!("/api/v1/org-changes/{id}/approval-steps/{step}/decision")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn prior_decider_and_same_person_alias_cannot_decide_another_step(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let checker = actor(&pool, org).await;
    let (id, steps) = request(&pool, org, maker).await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let (_, before) = ctx
        .call("GET", &format!("/api/v1/org-changes/{id}"), None)
        .await;
    let body = json!({"decision":"APPROVED", "expected_version":before["version"]});
    assert_eq!(
        ctx.call("POST", &path(id, steps[0]), Some(body.clone()))
            .await
            .0,
        StatusCode::OK
    );
    let (_, after) = ctx
        .call("GET", &format!("/api/v1/org-changes/{id}"), None)
        .await;
    assert_ne!(before["version"], after["version"]);
    let person: Uuid = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(checker.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    let alias = actor(&pool, org).await;
    person_fixtures::bind_user_to_person(&pool, alias, person).await;
    for user in [checker, alias] {
        let ctx = http::ctx(&pool, org, user, &["EXECUTIVE"], None).await;
        for decision in ["APPROVED", "REJECTED"] {
            let before = snapshot(&pool, id).await;
            let (status, refused) = ctx
                .call(
                    "POST",
                    &path(id, steps[1]),
                    Some(json!({"decision":decision})),
                )
                .await;
            assert_eq!(status, StatusCode::CONFLICT, "{refused}");
            assert_eq!(refused["error"]["code"], "org_change_sod_violation");
            assert!(
                refused["error"]["support_ref"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            );
            assert_eq!(snapshot(&pool, id).await, before);
        }
    }
    let independent = actor(&pool, org).await;
    let ctx = http::ctx(&pool, org, independent, &["EXECUTIVE"], None).await;
    assert_eq!(
        ctx.call(
            "POST",
            &path(id, steps[1]),
            Some(json!({"decision":"APPROVED", "expected_version":after["version"]}))
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stale_merge_and_withdrawn_are_coded_without_writes(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let checker = actor(&pool, org).await;
    let (id, steps) = request(&pool, org, maker).await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let (_, detail) = ctx
        .call("GET", &format!("/api/v1/org-changes/{id}"), None)
        .await;
    let version = detail["version"].as_str().expect("opaque version");
    for (extra, code) in [
        (
            json!({"expected_version":"stale"}),
            "lifecycle.refuse.stale_version",
        ),
        (
            json!({"through_step":steps[1]}),
            "lifecycle.refuse.merge_not_allowed",
        ),
    ] {
        let mut body = extra;
        body["decision"] = json!("APPROVED");
        let before = snapshot(&pool, id).await;
        let (status, refused) = ctx.call("POST", &path(id, steps[0]), Some(body)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["error"]["code"], code);
        assert!(
            refused["error"]["support_ref"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        if code.ends_with("stale_version") {
            assert_eq!(refused["error"]["current_version"], json!(version));
        }
        assert_eq!(snapshot(&pool, id).await, before);
    }
    sqlx::query("UPDATE org_change_requests SET status='CANCELLED' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let before = snapshot(&pool, id).await;
    let (status, refused) = ctx
        .call(
            "POST",
            &path(id, steps[0]),
            Some(json!({"decision":"APPROVED","expected_version":"stale"})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "lifecycle.refuse.withdrawn");
    assert_eq!(snapshot(&pool, id).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_rechecks_live_grants_and_tenant_isolation(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let checker = actor(&pool, org).await;
    let (id, steps) = request(&pool, org, maker).await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    // Legacy EXECUTIVE floor still passes, but Cedar has no live grant now.
    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE account_id=$1")
        .bind(checker.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let before = snapshot(&pool, id).await;
    for extra in [
        json!({}),
        json!({"expected_version":"stale"}),
        json!({"through_step":steps[1]}),
    ] {
        let mut body = extra;
        body["decision"] = json!("APPROVED");
        assert_eq!(
            ctx.call("POST", &path(id, steps[0]), Some(body)).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(snapshot(&pool, id).await, before);
    let (other_org, other) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, other_org, other, &["SUPER_ADMIN"], None).await;
    assert_eq!(
        ctx.call(
            "POST",
            &path(id, steps[0]),
            Some(json!({"decision":"APPROVED"}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(snapshot(&pool, id).await, before);
}
