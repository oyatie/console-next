// SPDX-License-Identifier: LicenseRef-Proprietary
#[path = "../../../../../test_support/governed_erase.rs"]
mod governed_erase;
use super::*;
pub(super) use governed_erase::due;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn one_operator_cannot_erase_an_archived_tenant(owner_pool: PgPool) {
    let h = Harness::new(&owner_pool).await;
    let admin = seed_platform_admin(&owner_pool).await;
    let token = h.token(admin, OrgId::platform(), true).await;
    let service = h.service();
    let org = onboard(&service, &token, "erase-alone").await;
    archive_org(&service, &token, org).await;
    let mut key = real_key(&owner_pool, admin).await;
    let (status, body) =
        force_delete_org(&service, &token, org, Some((&owner_pool, &mut key))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "erase_requires_second_operator");
    assert!(org_exists(&owner_pool, org).await);
}

#[path = "../fixtures/operator_proof.rs"]
mod operator_proof;

#[allow(clippy::too_many_arguments)]
async fn command(
    h: &Harness,
    pool: &PgPool,
    user: UserId,
    key: &mut SoftKey,
    token: &str,
    org: Uuid,
    id: Uuid,
    action: &str,
) -> (StatusCode, Value) {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(format!("tenant_erase:{org}:{id}:{action}"))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let proof = operator_proof::proof(pool, *user.as_uuid(), key, id, hash).await;
    let path = if action == "open" {
        format!("/api/platform/orgs/{org}/erase")
    } else {
        format!("/api/platform/orgs/{org}/erase/{id}/{action}")
    };
    let mut body = serde_json::json!({"step_up":proof});
    if action == "open" {
        body["id"] = serde_json::json!(id);
    }
    let response = h
        .service()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn erasure_requires_two_bound_operators_and_waits_for_cooling(owner: PgPool) {
    let h = Harness::new(&owner).await;
    let a = seed_platform_admin(&owner).await;
    let at = h.token(a, OrgId::platform(), true).await;
    let mut ak = real_key(&owner, a).await;
    let service = h.service();
    let org = onboard(&service, &at, "erase-governed").await;
    archive_org(&service, &at, org).await;
    let id = Uuid::new_v4();
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "open").await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "erase_requires_second_operator");
    let b = seed_platform_admin(&owner).await;
    let bt = h.token(b, OrgId::platform(), true).await;
    let mut bk = real_key(&owner, b).await;
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "open").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "approve").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "erase_same_operator");
    sqlx::query("INSERT INTO platform_setting_overrides(key,value) VALUES('platform.tenant_erase_cooling','24')").execute(&owner).await.unwrap();
    let (status, body) = command(&h, &owner, b, &mut bk, &bt, org, id, "approve").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let duration: i64 = sqlx::query_scalar("SELECT extract(epoch FROM cooling_until-approved_at)::bigint FROM tenant_erase_requests WHERE id=$1").bind(id).fetch_one(&owner).await.unwrap();
    assert_eq!(duration, 24 * 60 * 60);
    assert!(body["cooling_until"].is_string());
    let provisioner = PlatformProvisioner::new(Duration::minutes(15));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT platform_run_due_tenant_erases()")
            .fetch_one(&h.force_pool)
            .await
            .unwrap(),
        0
    );
    let error = provisioner
        .force_remove_tenant(
            &h.force_pool,
            Some(b),
            org,
            OffsetDateTime::now_utc() + Duration::days(30),
        )
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "erase_cooling");
    assert!(org_exists(&owner, org).await);
    // Owner-only clock fixture: runtime cannot mutate an approved cooling receipt.
    sqlx::query("ALTER TABLE tenant_erase_requests DISABLE TRIGGER tenant_erase_request_guard")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_erase_requests SET opened_at=opened_at-interval '8 days',approved_at=approved_at-interval '8 days',cooling_until=cooling_until-interval '8 days' WHERE id=$1").bind(id).execute(&owner).await.unwrap();
    sqlx::query("ALTER TABLE tenant_erase_requests ENABLE TRIGGER tenant_erase_request_guard")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(b.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT platform_run_due_tenant_erases()")
            .fetch_one(&h.force_pool)
            .await
            .unwrap(),
        0
    );
    assert!(org_exists(&owner, org).await);
    sqlx::query("UPDATE users SET is_active=true WHERE id=$1")
        .bind(b.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT platform_run_due_tenant_erases()")
            .fetch_one(&h.force_pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT platform_run_due_tenant_erases()")
            .fetch_one(&h.force_pool)
            .await
            .unwrap(),
        0
    );
    assert!(!org_exists(&owner, org).await);
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE target_id=$1 AND action IN ('platform.tenant.erase.open','platform.tenant.erase.approve','platform.tenant.erase.run')").bind(id.to_string()).fetch_one(&owner).await.unwrap();
    assert_eq!(audits, 3);
    let hints:i64=sqlx::query_scalar("SELECT count(*) FROM resource_changes WHERE org_id=$1 AND resource_type='tenant_erase' AND resource_id=$2").bind(OrgId::platform().as_uuid()).bind(id.to_string()).fetch_one(&owner).await.unwrap();
    assert_eq!(hints, 3);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cancellation_preserves_the_tenant_before_cooling_ends(owner: PgPool) {
    let h = Harness::new(&owner).await;
    let a = seed_platform_admin(&owner).await;
    let b = seed_platform_admin(&owner).await;
    let at = h.token(a, OrgId::platform(), true).await;
    let bt = h.token(b, OrgId::platform(), true).await;
    let mut ak = real_key(&owner, a).await;
    let mut bk = real_key(&owner, b).await;
    let org = onboard(&h.service(), &at, "erase-cancel").await;
    let id = Uuid::new_v4();
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "open").await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "tenant_active");
    archive_org(&h.service(), &at, org).await;
    let hold:Uuid=sqlx::query_scalar("SELECT audit_legal_hold_place($1,'ERASE-CASE','order','preserve',$2,repeat('a',32)::char(32),repeat('b',16)::char(16),now())").bind(org).bind(a.as_uuid()).fetch_one(&owner).await.unwrap();
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "open").await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "blocked_legal_hold");
    sqlx::query("SELECT audit_legal_hold_release($1,'closed',$2,repeat('c',32)::char(32),repeat('d',16)::char(16),now())").bind(hold).bind(a.as_uuid()).execute(&owner).await.unwrap();
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "open").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = command(&h, &owner, b, &mut bk, &bt, org, id, "approve").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = command(&h, &owner, a, &mut ak, &at, org, id, "cancel").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["cancelled_at"].is_string());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT platform_run_due_tenant_erases()")
            .fetch_one(&h.force_pool)
            .await
            .unwrap(),
        0
    );
    assert!(org_exists(&owner, org).await);
    // The same database guard that runs the worker also refuses an unapproved legacy caller.
    let error = PlatformProvisioner::new(Duration::ZERO)
        .force_remove_tenant(&h.force_pool, Some(b), org, OffsetDateTime::now_utc())
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "erase_requires_second_operator");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn erasure_read_serves_preconditions_and_overdue_unexecuted_erase_is_cancellable(
    owner: PgPool,
) {
    let h = Harness::new(&owner).await;
    let a = seed_platform_admin(&owner).await;
    let at = h.token(a, OrgId::platform(), true).await;
    let org = onboard(&h.service(), &at, "erase-facts").await;
    let p = PlatformProvisioner::new(Duration::ZERO);
    let facts = p
        .read_tenant_erase(&h.rt_pool, org, OffsetDateTime::now_utc())
        .await
        .unwrap();
    assert!(!facts.archived);
    assert!(!facts.legal_hold);
    assert!(!facts.second_operator_available);
    archive_org(&h.service(), &at, org).await;
    let b = seed_platform_admin(&owner).await;
    let bt = h.token(b, OrgId::platform(), true).await;
    let mut bk = real_key(&owner, b).await;
    governed_erase::due(&owner, org, *b.as_uuid()).await;
    let facts = p
        .read_tenant_erase(&h.rt_pool, org, OffsetDateTime::now_utc())
        .await
        .unwrap();
    assert!(facts.archived);
    assert!(facts.second_operator_available);
    let id = facts.request.unwrap().id;
    let (status, body) = command(&h, &owner, b, &mut bk, &bt, org, id, "cancel").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["cancelled_at"].is_string());
    assert_eq!(
        PlatformProvisioner::run_due_tenant_erases(&h.force_pool)
            .await
            .unwrap(),
        0
    );
    assert!(org_exists(&owner, org).await);
}

#[path = "current_data.rs"]
mod current_data;

#[path = "erase_sql.rs"]
mod sql;
