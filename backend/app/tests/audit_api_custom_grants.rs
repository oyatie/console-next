// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod settings_support;

use console_app::build_router;
use console_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::StatusCode;
use settings_support::{app_state, keys, runtime_pool, seed_legal_entity, seed_user, send};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

async fn setup_branch(pool: &PgPool, org: Uuid, name: &str) -> BranchId {
    let region: Uuid = sqlx::query_scalar(
        "INSERT INTO regions(id, name, org_id) VALUES(gen_random_uuid(), $1, $2) RETURNING id",
    )
    .bind(format!("reg-{name}-{}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches(id, region_id, name, org_id) VALUES(gen_random_uuid(), $1, $2, $3) RETURNING id",
    )
    .bind(region)
    .bind(name)
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(id)
}

async fn setup_workplace(pool: &PgPool, org: Uuid, entity: Uuid, branch: BranchId) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workplaces (org_id, id, legal_entity_id, default_branch_id, needs_confirmation, created_change_mode)
         VALUES ($1, $2, $3, $4, true, 'MIGRATION')",
    )
    .bind(org)
    .bind(id)
    .bind(entity)
    .bind(*branch.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn grant_audit_view(
    pool: &PgPool,
    org: Uuid,
    granter: UserId,
    grantee: UserId,
    scope_kind: &str,
    workplace_id: Option<Uuid>,
) -> Uuid {
    let role_id = Uuid::new_v4();
    let role_name = format!("audit reader {}", &role_id.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO access_roles (org_id, id, name_ko, status, version, created_by)
         VALUES ($1, $2, $3, 'ACTIVE', 1, $4)",
    )
    .bind(org)
    .bind(role_id)
    .bind(&role_name)
    .bind(*granter.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_versions (org_id, role_id, version, name_ko, status, change_mode, created_by)
         VALUES ($1, $2, 1, $3, 'ACTIVE', 'SETUP', $4)",
    )
    .bind(org)
    .bind(role_id)
    .bind(&role_name)
    .bind(*granter.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_lines (org_id, role_id, version, domain, levels)
         VALUES ($1, $2, 1, 'audit', ARRAY['view'])",
    )
    .bind(org)
    .bind(role_id)
    .execute(pool)
    .await
    .unwrap();

    let grant_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO access_grants (
            org_id, id, account_id, role_id, scope_kind, workplace_id,
            valid_from, effective_in_setup, change_mode, reason_code, granted_by
         ) VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 minute', true, 'SETUP', 'TEST', $7)",
    )
    .bind(org)
    .bind(grant_id)
    .bind(*grantee.as_uuid())
    .bind(role_id)
    .bind(scope_kind)
    .bind(workplace_id)
    .bind(*granter.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    grant_id
}

async fn insert_audit(pool: &PgPool, org: Uuid, branch: BranchId, target_id: &str) {
    let event = AuditEvent::new(
        None,
        AuditAction::new("work_order.view").unwrap(),
        "work_order",
        target_id,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    );
    sqlx::query(
        "INSERT INTO audit_events (id, actor, action, target_type, target_id, branch_id, trace_id, span_id, occurred_at, org_id)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(*event.id.as_uuid())
    .bind(event.action.as_str())
    .bind(event.target_type)
    .bind(event.target_id)
    .bind(*branch.as_uuid())
    .bind(event.trace.trace_id())
    .bind(event.trace.span_id())
    .bind(event.occurred_at)
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
}

async fn member_token(
    pool: &PgPool,
    keys: &(String, String),
    org: Uuid,
    user: UserId,
    branches: Vec<BranchId>,
) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "console-platform-auth".to_owned(),
            audience: "console-api".to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.0.as_bytes(),
        keys.1.as_bytes(),
    )
    .unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::from_uuid(org),
            roles: vec!["MEMBER".to_owned()],
            branches,
            platform: false,
            support: None,
            read_only: false,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        },
        None,
        Vec::new(),
    )
    .await
}

async fn add_branch(pool: &PgPool, org: Uuid, user: UserId, branch: BranchId) {
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user.as_uuid())
        .bind(*branch.as_uuid())
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn custom_audit_view_grants_honor_tenant_workplace_scope_and_revocation(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Audit Grants Org')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();

    let granter = seed_user(&pool, org, "SUPER_ADMIN").await;
    let entity = seed_legal_entity(&pool, org, granter).await;
    let branch_a = setup_branch(&pool, org, "BranchA").await;
    let branch_b = setup_branch(&pool, org, "BranchB").await;
    let wp_a = setup_workplace(&pool, org, entity, branch_a).await;

    insert_audit(&pool, org, branch_a, "evt-a").await;
    insert_audit(&pool, org, branch_b, "evt-b").await;

    let keys = keys();
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1.clone()).unwrap());

    // 1. Member with TENANT audit:view grant receives 200 and sees rows; revocation flips to 403.
    let tenant_member = seed_user(&pool, org, "MEMBER").await;
    let tenant_grant = grant_audit_view(&pool, org, granter, tenant_member, "TENANT", None).await;
    let tenant_tok = member_token(&pool, &keys, org, tenant_member, vec![]).await;
    let (st, body) = send(
        &service,
        "GET",
        "/api/audit?target_type=work_order",
        Some(&tenant_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    let ids: Vec<&str> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["target_id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"evt-a") && ids.contains(&"evt-b"), "{ids:?}");

    sqlx::query(
        "UPDATE access_grants SET status = 'REVOKED', revoked_by = $1, revoked_at = now() WHERE org_id = $2 AND id = $3",
    )
    .bind(*granter.as_uuid())
    .bind(org)
    .bind(tenant_grant)
    .execute(&pool)
    .await
    .unwrap();
    let (st, revoked_body) = send(
        &service,
        "GET",
        "/api/audit?target_type=work_order",
        Some(&tenant_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{revoked_body}");

    // 2. Member with WORKPLACE audit:view on BranchA + user_branches {BranchA, BranchB} -> 403.
    let multi_member = seed_user(&pool, org, "MEMBER").await;
    add_branch(&pool, org, multi_member, branch_a).await;
    add_branch(&pool, org, multi_member, branch_b).await;
    grant_audit_view(&pool, org, granter, multi_member, "WORKPLACE", Some(wp_a)).await;
    let multi_tok = member_token(&pool, &keys, org, multi_member, vec![branch_a, branch_b]).await;
    let (st, multi_body) = send(
        &service,
        "GET",
        "/api/audit?target_type=work_order",
        Some(&multi_tok),
        None,
    )
    .await;
    assert_eq!(
        st,
        StatusCode::FORBIDDEN,
        "partial workplace grant must not authorize {branch_a:?}+{branch_b:?}: {multi_body}"
    );

    // 3. Member with WORKPLACE audit:view on BranchA + user_branches {BranchA} -> 200 seeing only BranchA.
    let scoped_member = seed_user(&pool, org, "MEMBER").await;
    add_branch(&pool, org, scoped_member, branch_a).await;
    grant_audit_view(&pool, org, granter, scoped_member, "WORKPLACE", Some(wp_a)).await;
    let scoped_tok = member_token(&pool, &keys, org, scoped_member, vec![branch_a]).await;
    let (st, scoped_body) = send(
        &service,
        "GET",
        "/api/audit?target_type=work_order",
        Some(&scoped_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{scoped_body}");
    let scoped_ids: Vec<&str> = scoped_body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["target_id"].as_str().unwrap())
        .collect();
    assert_eq!(scoped_ids, vec!["evt-a"]);
}
