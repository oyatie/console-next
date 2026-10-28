// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use uuid::Uuid;

pub(super) async fn grant(
    pool: &PgPool,
    org: OrgId,
    user: UserId,
    levels: &[&str],
    entity: Option<Uuid>,
) -> Uuid {
    let grantor =
        console_platform_test_support::seed_active_user(pool, *org.as_uuid(), "MEMBER", "grantor")
            .await;
    let role: Uuid = sqlx::query_scalar("INSERT INTO access_roles(org_id,name_ko,status,version,created_by) VALUES($1,gen_random_uuid()::text,'ACTIVE',1,$2) RETURNING id")
        .bind(org.as_uuid()).bind(user.as_uuid()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'점검','ACTIVE','OPERATING',$3)")
        .bind(org.as_uuid()).bind(role).bind(user.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'audit',$3)")
        .bind(org.as_uuid()).bind(role).bind(levels).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,CASE WHEN $4::uuid IS NULL THEN 'TENANT' ELSE 'LEGAL_ENTITY' END,$4,now()-interval '1 day',true,'SETUP','TEST',$5)")
        .bind(org.as_uuid()).bind(user.as_uuid()).bind(role).bind(entity).bind(grantor.as_uuid()).execute(pool).await.unwrap();
    role
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_requires_tenant_wide_approve_and_reloads_revoked_access(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "grant-record").await;
    let entity = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES($1,$2,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(entity).execute(&pool).await.unwrap();
    grant(&pool, org, user, &["approve"], Some(entity)).await;
    let service = AccessService::new(runtime_role_pool(&pool).await, None);
    let p = principal(org, user);
    assert_eq!(
        record::start(
            &service,
            p.clone(),
            "2026-09".into(),
            "scoped-review-start".into()
        )
        .await
        .unwrap_err()
        .code,
        "scope_tenant_wide_only"
    );
    let reader =
        console_platform_test_support::seed_active_user(&pool, *org.as_uuid(), "MEMBER", "reader")
            .await;
    let role = grant(&pool, org, reader, &["view"], None).await;
    let reader = principal(org, reader);
    assert_eq!(
        record::start(
            &service,
            reader.clone(),
            "2026-09".into(),
            "reader-review-start".into()
        )
        .await
        .unwrap_err()
        .code,
        "access_denied"
    );
    grant(&pool, org, user, &["approve"], None).await;
    record::start(&service, p, "2026-09".into(), "scoped-review-start".into())
        .await
        .unwrap();
    assert!(
        record::frozen_page(&service, reader.clone(), "2026-09".into(), None, 50)
            .await
            .unwrap()
            .is_empty()
    );
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$3 WHERE org_id=$1 AND role_id=$2")
        .bind(org.as_uuid())
        .bind(role)
        .bind(user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        record::frozen_page(&service, reader, "2026-09".into(), None, 50)
            .await
            .unwrap_err()
            .code,
        "access_denied"
    );
    let refused: Vec<(String, String)> = sqlx::query_as("SELECT after_snap->>'code',outcome FROM audit_events WHERE org_id=$1 AND action='access_log_review.refused' ORDER BY created_at,id")
        .bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
    assert_eq!(
        refused,
        [
            ("scope_tenant_wide_only".into(), "DENIED".into()),
            ("access_denied".into(), "DENIED".into())
        ]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn failed_audit_insert_returns_no_frozen_rows_or_start(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "audit-fails").await;
    reviewer(&pool, org, user).await;
    let service = AccessService::new(runtime_role_pool(&pool).await, None);
    let p = principal(org, user);
    record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "audit-failure-start".into(),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE FUNCTION reject_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('access_log.review_read','access_log_review.start') THEN RAISE EXCEPTION 'test write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_review_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_review_audit()")
        .execute(&pool).await.unwrap();
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap_err()
            .kind,
        console_platform_access::Refusal::Internal
    );
    assert_eq!(
        record::frozen_page(&service, p.clone(), "2026-09".into(), None, 50)
            .await
            .unwrap_err()
            .kind,
        console_platform_access::Refusal::Internal
    );
    assert_eq!(
        record::start(
            &service,
            p,
            "2026-08".into(),
            "audit-failure-start-2".into()
        )
        .await
        .unwrap_err()
        .kind,
        console_platform_access::Refusal::Internal
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action IN ('access_log.review_read','access_log_review.start')")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
    let reserved: i64 = sqlx::query_scalar("SELECT count(*) FROM api_idempotency_keys WHERE org_id=$1 AND idempotency_key='audit-failure-start-2'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(reserved, 0);
}
