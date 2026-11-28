// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn seed_fixture(pool: &PgPool) -> Fixture {
    let org = OrgId::one();
    let other_org = OrgId::from_uuid(Uuid::new_v4());
    seed_org(pool, org, "sae", "SAE").await;
    seed_org(pool, other_org, "consulting-other", "Consulting Other").await;

    sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,'consulting',true,'consulting-test')")
        .bind(org.as_uuid()).execute(pool).await.unwrap();

    let requester = UserId::new();
    let approver = UserId::new();
    let other_user = UserId::new();
    seed_user(pool, org, requester, "Consulting Requester").await;
    seed_user(pool, org, approver, "Consulting Approver").await;
    person_fixtures::bind_user_to_distinct_person(pool, requester).await;
    person_fixtures::bind_user_to_distinct_person(pool, approver).await;
    seed_user(pool, other_org, other_user, "Other Tenant User").await;
    seed_consulting_policy(pool, org, &[requester, approver]).await;

    let branch = seed_branch(pool, org, "Consulting Primary").await;
    let other_branch = seed_branch(pool, other_org, "Consulting Other").await;
    let customer = seed_customer(pool, org, branch, "Consulting Customer").await;
    let other_customer =
        seed_customer(pool, other_org, other_branch, "Other Tenant Customer").await;

    let document = seed_reference(pool, org, requester, "DOCUMENT").await;
    let ontology = seed_reference(pool, org, requester, "ONTOLOGY_INSTANCE").await;
    let evidence = seed_reference(pool, org, requester, "EVIDENCE").await;
    let kpi = seed_reference(pool, org, requester, "KPI_DEFINITION").await;

    let other_org_engagement: Uuid = sqlx::query_scalar(
        "INSERT INTO consulting_engagements \
         (org_id, customer_id, title, idempotency_key, idempotency_request_hash, created_by) \
         VALUES ($1, $2, 'Other tenant engagement', 'other-tenant-key', \
         'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', $3) \
         RETURNING id",
    )
    .bind(*other_org.as_uuid())
    .bind(other_customer)
    .bind(*other_user.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();

    Fixture {
        org,
        other_org_engagement,
        requester,
        approver,
        customer,
        document,
        ontology,
        evidence,
        kpi,
    }
}

async fn seed_org(pool: &PgPool, org: OrgId, slug: &str, name: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(*org.as_uuid())
    .bind(slug)
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
}

pub(super) async fn seed_user(pool: &PgPool, org: OrgId, user: UserId, name: &str) {
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, is_active, org_id) \
         VALUES ($1, $2, $3, true, $4)",
    )
    .bind(*user.as_uuid())
    .bind(name)
    .bind(vec!["SUPER_ADMIN".to_owned()])
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
}

async fn seed_consulting_policy(pool: &PgPool, org: OrgId, users: &[UserId]) {
    let role_id: Uuid = sqlx::query_scalar(
        "INSERT INTO policy_roles \
         (org_id, role_key, display_name, status, is_system) \
         VALUES ($1, 'consulting_test_operator', 'Consulting test operator', 'ACTIVE', false) \
         RETURNING id",
    )
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    for feature in ["consulting_read", "consulting_manage"] {
        sqlx::query(
            "INSERT INTO policy_role_permissions \
             (org_id, role_id, feature_key, permission_level) \
             VALUES ($1, $2, $3, 'allow')",
        )
        .bind(*org.as_uuid())
        .bind(role_id)
        .bind(feature)
        .execute(pool)
        .await
        .unwrap();
    }
    for user in users {
        sqlx::query(
            "INSERT INTO user_role_assignments (org_id, user_id, role_id) \
             VALUES ($1, $2, $3)",
        )
        .bind(*org.as_uuid())
        .bind(*user.as_uuid())
        .bind(role_id)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn seed_branch(pool: &PgPool, org: OrgId, name: &str) -> Uuid {
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (org_id, name) VALUES ($1, $2) RETURNING id")
            .bind(*org.as_uuid())
            .bind(format!("{name} Region"))
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query_scalar(
        "INSERT INTO branches (org_id, region_id, name) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(region)
    .bind(name)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn seed_customer(pool: &PgPool, org: OrgId, branch: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO registry_customers (org_id, branch_id, name) \
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(branch)
    .bind(name)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub(super) async fn seed_reference(pool: &PgPool, org: OrgId, actor: UserId, kind: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO consulting_reference_bindings \
         (org_id, source_kind, source_id, source_version, evaluated_by) \
         VALUES ($1, $2, $3, 'v1', $4) RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(kind)
    .bind(Uuid::new_v4())
    .bind(*actor.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

pub(super) async fn seed_approval(
    pool: &PgPool,
    org: OrgId,
    requester: UserId,
    approver: UserId,
    engagement_id: Uuid,
) -> Uuid {
    console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(pool, org, move |tx| {
        Box::pin(async move {
            sqlx::query_scalar(
                "INSERT INTO gov_approvals \
                 (org_id, request_ref, kind, requested_by, approver_id, decision, target_ref) \
                 VALUES ($1, $2, 'consulting.engagement.approval', $3, $4, 'approved', $5) \
                 RETURNING id",
            )
            .bind(*org.as_uuid())
            .bind(Uuid::new_v4())
            .bind(*requester.as_uuid())
            .bind(*approver.as_uuid())
            .bind(engagement_id)
            .fetch_one(tx.as_mut())
            .await
            .map_err(console_platform_db::DbError::from)
        })
    })
    .await
    .unwrap()
}

pub(super) async fn count_engagements(pool: &PgPool, org: OrgId, key: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM consulting_engagements WHERE org_id=$1 AND idempotency_key=$2",
    )
    .bind(*org.as_uuid())
    .bind(key)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub(super) async fn approval_consumptions(pool: &PgPool, approval_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM gov_approval_consumptions WHERE approval_id=$1")
        .bind(approval_id)
        .fetch_one(pool)
        .await
        .unwrap()
}
