#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
use console_kernel_core::{OrgId, TraceContext};
use console_onboarding_adapter_postgres::{OnboardingActor, PgOnboardingError, PgOnboardingStore};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

pub async fn tenant(owner: &PgPool) -> (PgOnboardingStore, OnboardingActor) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(owner, *org.as_uuid(), "onboarding").await;
    // rls-arming: ok test fixture assigns the sole ops holder before using console_rt.
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(user.as_uuid())
        .execute(owner)
        .await
        .unwrap();
    (
        PgOnboardingStore::new(runtime_role_pool(owner).await),
        OnboardingActor {
            org,
            user,
            roles: vec!["SUPER_ADMIN".into()],
            trace: TraceContext::generate(),
        },
    )
}

pub async fn publish(owner: &PgPool, version: &str, body: &str, days_ago: i32) -> String {
    // rls-arming: ok immutable test terms fixture, never production terms.
    sqlx::query_scalar("INSERT INTO terms_documents (version, body, published_at) VALUES ($1, $2, now() - make_interval(days => $3)) RETURNING sha256")
        .bind(version).bind(body).bind(days_ago).fetch_one(owner).await.unwrap()
}

pub async fn snapshot(owner: &PgPool, a: &OnboardingActor) -> (String, i64, i64) {
    let phase = sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id = $1")
        .bind(a.org.as_uuid())
        .fetch_one(owner)
        .await
        .unwrap();
    let acceptances =
        sqlx::query_scalar("SELECT count(*) FROM tenant_terms_acceptances WHERE org_id = $1")
            .bind(a.org.as_uuid())
            .fetch_one(owner)
            .await
            .unwrap();
    let choices = sqlx::query_scalar("SELECT count(*) FROM tenant_phase_events WHERE org_id = $1")
        .bind(a.org.as_uuid())
        .fetch_one(owner)
        .await
        .unwrap();
    (phase, acceptances, choices)
}

pub async fn refused(
    owner: &PgPool,
    a: &OnboardingActor,
    before: (String, i64, i64),
    err: PgOnboardingError,
    code: &str,
) {
    assert!(
        matches!(&err, PgOnboardingError::Refused { code: actual, .. } if *actual == code),
        "{err:?}"
    );
    assert_eq!(
        before,
        snapshot(owner, a).await,
        "no business state changed"
    );
    let logged: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM audit_events WHERE org_id = $1 AND action = 'tenant.onboarding_refused' AND after_snap->>'code' = $2)")
        .bind(a.org.as_uuid()).bind(code).fetch_one(owner).await.unwrap();
    assert!(logged, "the refused code is audited after rollback");
}

pub async fn operating(owner: &PgPool, a: &OnboardingActor) {
    // rls-arming: ok owner-only test fixture changes the phase.
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = $1")
        .bind(a.org.as_uuid())
        .execute(owner)
        .await
        .unwrap();
}

pub fn details(err: &PgOnboardingError) -> &Value {
    match err {
        PgOnboardingError::Refused {
            details: Some(d), ..
        } => d,
        _ => panic!("expected refusal details"),
    }
}

pub async fn hr(owner: &PgPool, a: &OnboardingActor) -> OnboardingActor {
    let user = console_platform_test_support::seed_active_user(
        owner,
        *a.org.as_uuid(),
        "SUPER_ADMIN",
        "HR",
    )
    .await;
    OnboardingActor {
        user,
        roles: vec!["SUPER_ADMIN".into()],
        ..a.clone()
    }
}

pub async fn grant_employees(
    owner: &PgPool,
    a: &OnboardingActor,
    hr: &OnboardingActor,
    setup: bool,
) {
    let role = Uuid::new_v4();
    // rls-arming: ok fixtures exercise the production grant loader through console_rt below.
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'Test HR','ACTIVE',1,$3)").bind(a.org.as_uuid()).bind(role).bind(a.user.as_uuid()).execute(owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'Test HR','ACTIVE','SETUP',$3)").bind(a.org.as_uuid()).bind(role).bind(a.user.as_uuid()).execute(owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view','edit'])").bind(a.org.as_uuid()).bind(role).execute(owner).await.unwrap();
    // Already effective on both clocks: the PostgreSQL VM can lead the host grant-loader clock.
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now() - interval '1 day',$4,'SETUP','TEST',$5)").bind(a.org.as_uuid()).bind(hr.user.as_uuid()).bind(role).bind(setup).bind(a.user.as_uuid()).execute(owner).await.unwrap();
}
