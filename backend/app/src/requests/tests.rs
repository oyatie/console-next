use super::read;
use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};
use console_kernel_core::{
    AuditAction, AuditCommandContext, AuditEvent, BranchScope, OrgId, TraceContext, UserId,
};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use console_platform_db::{DbError, command_context, command_outcomes, with_audit};
use console_platform_test_support::{
    MIGRATOR, runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

pub(super) struct Fixture {
    pub(super) owner: PgPool,
    pub(super) rt: PgPool,
    pub(super) submitter: Principal,
    subject: UserId,
}
impl Fixture {
    pub(super) async fn new(owner: PgPool) -> Self {
        let org = OrgId::new();
        let actor = seed_org_and_super_admin(&owner, *org.as_uuid(), "requests-read").await;
        let subject = seed_active_user(&owner, *org.as_uuid(), "MEMBER", "subject").await;
        Self {
            rt: runtime_role_pool(&owner).await,
            owner,
            submitter: Principal::new(
                actor,
                org,
                BTreeSet::from([Role::SuperAdmin]),
                BranchScope::All,
            ),
            subject,
        }
    }
    async fn applied(&self, key: &str) -> Uuid {
        let p = &self.submitter;
        let reserved = command_outcomes::reserve(
            &self.rt,
            p.org_id,
            p.user_id,
            key.into(),
            "POST /users".into(),
            b"masked-request-fixture".to_vec(),
            json!({"fields":["display_name"]}),
        )
        .await
        .unwrap();
        let command_outcomes::Reservation::Fresh(id) = reserved else {
            panic!("fixture command must be new");
        };
        let mut context = AuditCommandContext::for_actor(Some(p.user_id));
        context.command_id = Some(id);
        context.org_id = Some(p.org_id);
        let event = AuditEvent::new(
            Some(p.user_id),
            AuditAction::new("user.update").unwrap(),
            "user",
            self.subject.to_string(),
            TraceContext::generate(),
            time::OffsetDateTime::now_utc(),
        )
        .with_org(p.org_id);
        let result = json!({"id":self.subject,"display_name":"private-result-value"});
        command_context::scope(
            context,
            with_audit::<_, _, DbError>(&self.rt, event, move |tx| {
                Box::pin(async move { command_outcomes::set_result(tx, &result).await })
            }),
        )
        .await
        .unwrap();
        id
    }
    async fn commands(&self) -> Vec<Value> {
        sqlx::query_scalar("SELECT to_jsonb(c) FROM command_outcomes c ORDER BY org_id,id")
            .fetch_all(&self.owner)
            .await
            .unwrap()
    }
    async fn business(&self) -> Vec<Value> {
        sqlx::query_scalar("SELECT to_jsonb(u) FROM users u ORDER BY org_id,id")
            .fetch_all(&self.owner)
            .await
            .unwrap()
    }
    async fn denial_count(&self, p: &Principal, code: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND actor=$2
            AND action='command.refused' AND outcome='DENIED' AND after_snap->>'refusal_code'=$3",
        )
        .bind(p.org_id.as_uuid())
        .bind(p.user_id.as_uuid())
        .bind(code)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }
    async fn refused(&self, p: Principal, key: &str, status: StatusCode, code: &str) {
        let commands = self.commands().await;
        let business = self.business().await;
        let denials = self.denial_count(&p, code).await;
        let response = read(self.rt.clone(), p.clone(), key.into())
            .await
            .unwrap_err()
            .into_response();
        assert_eq!(response.status(), status);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["error"]["code"], code);
        assert_eq!(
            self.commands().await,
            commands,
            "refusal cannot change command outcomes"
        );
        assert_eq!(
            self.business().await,
            business,
            "refusal cannot change business records"
        );
        assert_eq!(self.denial_count(&p, code).await, denials + 1);
        let evidence: Value = sqlx::query_scalar(
            "SELECT after_snap FROM audit_events
            WHERE org_id=$1 AND actor=$2 AND action='command.refused'
            AND after_snap->>'refusal_code'=$3 ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .bind(p.org_id.as_uuid())
        .bind(p.user_id.as_uuid())
        .bind(code)
        .fetch_one(&self.owner)
        .await
        .unwrap();
        assert_eq!(
            evidence,
            json!({"refusal_code":code}),
            "no attempted input enters the denial audit"
        );
    }
    async fn member(&self) -> Principal {
        let org = self.submitter.org_id;
        let actor = seed_active_user(&self.owner, *org.as_uuid(), "MEMBER", "reader").await;
        Principal::new(actor, org, BTreeSet::from([Role::Member]), BranchScope::All)
    }
}
fn no_identity_fields(out: &Value) {
    assert!(out.get("org_id").is_none());
    assert!(out.get("actor_id").is_none());
}

#[test]
fn malformed_lookup_is_refused() {
    for key in ["", "short"] {
        assert!(command_outcomes::valid_lookup_key(key).is_err(), "{key}");
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn invalid_request_key_read_is_422_and_audited_without_writes(pool: PgPool) {
    let f = Fixture::new(pool).await;
    for key in ["", "short"] {
        f.refused(
            f.submitter.clone(),
            key,
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request_key",
        )
        .await;
    }
    assert!(f.commands().await.is_empty());
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn request_not_found_same_org_stranger_is_404_and_audited_without_writes(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let key = "requests-stranger-original";
    let id = f.applied(key).await;
    let stranger = f.member().await;
    for lookup in [id.to_string(), key.into()] {
        f.refused(
            stranger.clone(),
            &lookup,
            StatusCode::NOT_FOUND,
            "request_not_found",
        )
        .await;
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn request_not_found_other_tenant_is_404_and_audited_without_writes(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let key = "requests-other-tenant-original";
    let id = f.applied(key).await;
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&f.owner, *org.as_uuid(), "other-tenant").await;
    let other = Principal::new(
        actor,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    for lookup in [id.to_string(), key.into()] {
        f.refused(
            other.clone(),
            &lookup,
            StatusCode::NOT_FOUND,
            "request_not_found",
        )
        .await;
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn owner_keeps_state_but_lost_record_read_masks_result_and_touched(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let id = f.applied("requests-owner-masked").await;
    let visible = read(f.rt.clone(), f.submitter.clone(), id.to_string())
        .await
        .unwrap()
        .0;
    assert_eq!(visible["masked"], false);
    assert_eq!(visible["state"], "APPLIED");
    assert_eq!(visible["result"]["display_name"], "private-result-value");
    let original = f.commands().await;
    let mut lost = f.submitter.clone();
    lost.roles = BTreeSet::from([Role::Member]);
    lost.effective_feature_grants.clear();
    let masked = read(f.rt.clone(), lost, id.to_string()).await.unwrap().0;
    assert_eq!(masked["masked"], true);
    assert!(masked["result"].is_null());
    assert_eq!(masked["touched"], json!([]));
    for field in [
        "id",
        "state",
        "deadline",
        "created_at",
        "settled_at",
        "inputs_masked",
    ] {
        assert_eq!(masked[field], visible[field], "owner retains {field}");
    }
    assert_eq!(masked["inputs_masked"], json!({"fields":["display_name"]}));
    assert!(!masked.to_string().contains("private-result-value"));
    no_identity_fields(&masked);
    assert_eq!(
        f.commands().await,
        original,
        "masking must not rewrite the durable receipt"
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn current_record_reader_can_lookup_another_actors_outcome_without_identity_fields(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let key = "requests-authorized-reader";
    let id = f.applied(key).await;
    let reader = f
        .member()
        .await
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::UserManage,
            PermissionLevel::Allow,
            BranchScope::All,
        )]);
    assert_ne!(reader.user_id, f.submitter.user_id);
    let original = f.commands().await;
    for lookup in [id.to_string(), key.into()] {
        let out = read(f.rt.clone(), reader.clone(), lookup).await.unwrap().0;
        assert_eq!(out["id"], id.to_string());
        assert_eq!(out["state"], "APPLIED");
        assert_eq!(out["masked"], false);
        assert_eq!(out["result"]["display_name"], "private-result-value");
        assert_eq!(out["touched"].as_array().unwrap().len(), 1);
        assert_eq!(out["touched"][0]["type"], "user");
        assert_eq!(out["touched"][0]["id"], f.subject.to_string());
        no_identity_fields(&out);
        assert!(!out.to_string().contains(&f.submitter.org_id.to_string()));
        assert!(!out.to_string().contains(&f.submitter.user_id.to_string()));
    }
    assert_eq!(f.commands().await, original);
}
