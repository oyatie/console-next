// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "../src/wiring/orgchange_sole_holder.rs"]
mod implementation;
#[path = "../../test-support/org_change_fixtures.rs"]
mod org_change_fixtures;
#[path = "../../test-support/person_fixtures.rs"]
mod person_fixtures;

use console_kernel_core::{OrgId, UserId};
use console_orgchange_adapter_postgres::PgOrgChangeStore;
use console_orgchange_domain::StepDecisionCommand;
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_request_context::scope_org;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
    soft_passkey::{SoftKey, passkey_service},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

#[path = "org_change_sole_holder/support.rs"]
mod support;
use support::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn each_step_persists_its_bound_exception_notices_and_configured_review(pool: PgPool) {
    for phase in ["SETUP", "OPERATING"] {
        let mut w = world(&pool).await;
        sqlx::query("INSERT INTO tenant_phase(org_id,phase) VALUES($1,$2) ON CONFLICT(org_id) DO UPDATE SET phase=$2")
        .bind(w.org.as_uuid()).bind(phase).execute(&pool).await.unwrap();
        let recipient = seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "reviewer").await;
        org_change_fixtures::grant_org_levels(&pool, recipient, &["view"]).await;
        seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "without-access").await;
        for (index, step) in w.steps.clone().into_iter().enumerate() {
            let body = command(&pool, &mut w).await;
            let done = scope_org(
                w.org,
                w.store.decide_step_command(w.actor, w.id, step, body),
            )
            .await
            .unwrap();
            assert_eq!(
                done.summary.status.as_db(),
                if index == 3 {
                    "APPROVED"
                } else {
                    "IN_APPROVAL"
                }
            );
            assert_eq!(
                done.approval_steps
                    .iter()
                    .filter(|s| s.decided_at.is_some())
                    .count(),
                index + 1
            );
            let row: (String,String,Uuid,bool,bool)=sqlx::query_as("SELECT e.fallback_kind,e.status,e.requested_by,e.review_due_at=e.created_at+make_interval(days => $2),e.consumed_at IS NOT NULL FROM governed_exceptions e JOIN org_change_approval_steps s ON s.sole_holder_exception_id=e.id WHERE s.id=$1").bind(step).bind(REVIEW_DAYS).fetch_one(&pool).await.unwrap();
            assert_eq!(
                row,
                (
                    "SOLE_HOLDER".into(),
                    "RECORDED".into(),
                    *w.actor.as_uuid(),
                    true,
                    true
                )
            );
            let notice:(String,Value)=sqlx::query_as("SELECT body,link FROM notifications WHERE recipient_user_id=$1 ORDER BY created_at DESC LIMIT 1").bind(recipient.as_uuid()).fetch_one(&pool).await.unwrap();
            assert!(notice.0.contains("조직 변경"));
            assert_eq!(notice.1["id"], w.id.to_string());
            assert_eq!(notice.1["type"], "object");
            assert_eq!(notice.1["kind"], "org_change");
        }
        let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM governed_exceptions WHERE org_id=$1),(SELECT count(*) FROM notifications WHERE org_id=$1),(SELECT count(*) FROM step_up_assertions WHERE org_id=$1)").bind(w.org.as_uuid()).fetch_one(&pool).await.unwrap();
        assert_eq!(counts, (4, 4, 4));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn replay_wrong_step_binding_and_stale_consent_have_no_effects(pool: PgPool) {
    let mut w = world(&pool).await;
    for changed in [
        "step",
        "object",
        "hash",
        "reason",
        "action",
        "replay",
        "version",
        "missing_version",
        "proposal",
        "review",
        "recipients",
        "merge",
        "reject",
    ] {
        let mut body = command(&pool, &mut w).await;
        let step = if changed == "step" {
            w.steps[1]
        } else {
            w.steps[0]
        };
        match changed {
            "object" => {
                body.step_up.as_mut().unwrap()["binding"]["object_id"] = json!(Uuid::new_v4())
            }
            "hash" => {
                body.step_up.as_mut().unwrap()["binding"]["payload_hash"] = json!("a".repeat(64))
            }
            "reason" => body.step_up.as_mut().unwrap()["binding"]["reason_key"] = json!("other"),
            "action" => {
                body.step_up.as_mut().unwrap()["binding"]["action_kind"] = json!("APPROVAL_DECIDE")
            }
            "replay" => body.step_up.as_mut().unwrap()["binding"]["replay_attempt"] = json!(1),
            "version" => body.expected_version = Some("stale".into()),
            "missing_version" => body.expected_version = None,
            "proposal" => {
                sqlx::query("UPDATE org_change_requests SET reason=reason||' amended' WHERE id=$1")
                    .bind(w.id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "review" => {
                sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'review.sole_holder_exception.due',$3,$2,'TEST')").bind(w.org.as_uuid()).bind(w.actor.as_uuid()).bind(json!(REVIEW_DAYS - 1)).execute(&pool).await.unwrap();
            }
            "recipients" => {
                let recipient =
                    seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "recipient").await;
                org_change_fixtures::grant_org_levels(&pool, recipient, &["view"]).await;
            }
            "merge" => body.through_step = Some(w.steps[3]),
            "reject" => body.approved = false,
            _ => {}
        }
        let before = snapshot(&pool, &w).await;
        let error = scope_org(
            w.org,
            w.store.decide_step_command(w.actor, w.id, step, body),
        )
        .await
        .unwrap_err();
        if matches!(
            changed,
            "object"
                | "hash"
                | "reason"
                | "action"
                | "replay"
                | "proposal"
                | "review"
                | "recipients"
        ) {
            assert!(
                matches!(error,console_orgchange_adapter_postgres::PgOrgChangeError::Domain(e) if e.code==Some("step_up_failed")),
                "{changed}"
            );
        } else if matches!(changed, "version" | "missing_version") {
            assert!(
                matches!(
                    error,
                    console_orgchange_adapter_postgres::PgOrgChangeError::StaleVersion(_)
                ),
                "{changed}"
            );
        }
        assert_eq!(snapshot(&pool, &w).await, before, "{changed}");
    }
    let body = command(&pool, &mut w).await;
    let replay = StepDecisionCommand {
        approved: body.approved,
        expected_version: body.expected_version.clone(),
        step_up: body.step_up.clone(),
        ..Default::default()
    };
    scope_org(
        w.org,
        w.store.decide_step_command(w.actor, w.id, w.steps[0], body),
    )
    .await
    .unwrap();
    let before = snapshot(&pool, &w).await;
    assert!(
        scope_org(
            w.org,
            w.store
                .decide_step_command(w.actor, w.id, w.steps[0], replay)
        )
        .await
        .is_err()
    );
    assert_eq!(snapshot(&pool, &w).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn locked_facts_and_late_write_failure_roll_back_the_whole_decision(pool: PgPool) {
    for changed in [
        "holder",
        "identity",
        "policy",
        "route",
        "authority",
        "late_failure",
    ] {
        let mut w = world_with_route(&pool, changed != "route").await;
        if changed == "late_failure" {
            let recipient =
                seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "reviewer").await;
            org_change_fixtures::grant_org_levels(&pool, recipient, &["view"]).await;
        }
        if changed == "authority" {
            let person: Uuid = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
                .bind(w.actor.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
            let backup = seed_active_user(&pool, *w.org.as_uuid(), "ADMIN", "backup").await;
            let mut transfer = pool.begin().await.unwrap();
            sqlx::query("UPDATE users SET is_tenant_ops=false WHERE id=$1")
                .bind(w.actor.as_uuid())
                .execute(transfer.as_mut())
                .await
                .unwrap();
            sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
                .bind(backup.as_uuid())
                .execute(transfer.as_mut())
                .await
                .unwrap();
            transfer.commit().await.unwrap();
            person_fixtures::bind_user_to_person(&pool, backup, person).await;
            org_change_fixtures::grant_org_approve(&pool, w.actor).await;
        }
        let body = if changed == "route" {
            assert!(
                scope_org(w.org, w.store.sole_holder_consent(w.actor, w.id))
                    .await
                    .unwrap()
                    .is_none()
            );
            StepDecisionCommand {
                approved: true,
                expected_version: Some(scope_org(w.org, w.store.get(w.id)).await.unwrap().version),
                step_up: Some(json!({})),
                ..Default::default()
            }
        } else {
            command(&pool, &mut w).await
        };
        match changed {
            "holder" => {
                let other = seed_active_user(&pool, *w.org.as_uuid(), "ADMIN", "holder").await;
                person_fixtures::bind_user_to_distinct_person(&pool, other).await;
                org_change_fixtures::grant_org_approve(&pool, other).await;
            }
            "identity" => {
                sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,'ACCOUNT',$2,'NUMBER_BIRTH_AMBIGUOUS','{}')").bind(w.org.as_uuid()).bind(w.actor.as_uuid()).execute(&pool).await.unwrap();
            }
            "policy" => {
                sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'authz.sole_holder.mode','\"refuse\"',$2,'TEST')").bind(w.org.as_uuid()).bind(w.actor.as_uuid()).execute(&pool).await.unwrap();
            }
            "authority" => {
                sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE account_id=$1")
                    .bind(w.actor.as_uuid())
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "late_failure" => {
                sqlx::raw_sql("CREATE FUNCTION fail_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END $$; CREATE TRIGGER fail_decision BEFORE UPDATE ON org_change_approval_steps FOR EACH ROW EXECUTE FUNCTION fail_decision();").execute(&pool).await.unwrap();
            }
            _ => {}
        }
        let before = snapshot(&pool, &w).await;
        let error = scope_org(
            w.org,
            w.store.decide_step_command(w.actor, w.id, w.steps[0], body),
        )
        .await
        .unwrap_err();
        if changed == "late_failure" {
            assert!(error.to_string().contains("forced rollback"), "{error}");
        } else if changed == "identity" {
            assert!(
                matches!(error,console_orgchange_adapter_postgres::PgOrgChangeError::Domain(e) if e.code==Some("org_change.refuse.identity_unbound"))
            );
        } else if changed == "authority" {
            assert!(
                matches!(error,console_orgchange_adapter_postgres::PgOrgChangeError::Domain(e) if e.code==Some("org_change.refuse.missing_grant"))
            );
        }
        assert_eq!(snapshot(&pool, &w).await, before, "{changed}");
        if changed == "late_failure" {
            sqlx::raw_sql("DROP TRIGGER fail_decision ON org_change_approval_steps; DROP FUNCTION fail_decision();").execute(&pool).await.unwrap();
        }
    }
}

#[path = "org_change_sole_holder/notices.rs"]
mod notices;
