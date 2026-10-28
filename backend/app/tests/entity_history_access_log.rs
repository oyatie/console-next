// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! History logs only the personal fields returned, with real immutable row keys.
#[path = "support/http.rs"]
mod support;
#[path = "access_log_reads/support.rs"]
mod transport;

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use support::{Ctx, add_user, ctx, structure, tenant};
use time::OffsetDateTime;
use uuid::Uuid;

async fn world(pool: &PgPool) -> (Ctx, String, Uuid, Vec<String>, Vec<String>) {
    let (org, user) = tenant(pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, ..) = structure(&admin).await;
    let (revision, version): (Uuid, i32) = sqlx::query_as("SELECT id,version FROM legal_entity_revisions WHERE legal_entity_id=$1 ORDER BY version LIMIT 1")
        .bind(Uuid::parse_str(&entity).unwrap()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_directors(org_id,revision_id,seq,role,name) VALUES($1,$2,7,'AUDITOR','이전 감사')")
        .bind(org).bind(revision).execute(pool).await.unwrap();
    let (registration, revision, reg_version): (Uuid, Uuid, i32) = sqlx::query_as("SELECT b.id,r.id,r.version FROM business_registrations b JOIN business_registration_revisions r ON r.registration_id=b.id WHERE b.legal_entity_id=$1 ORDER BY r.version LIMIT 1")
        .bind(Uuid::parse_str(&entity).unwrap()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO business_registration_co_owners(org_id,revision_id,seq,name) VALUES($1,$2,4,'공동 사업자 가'),($1,$2,9,'공동 사업자 나')")
        .bind(org).bind(revision).execute(pool).await.unwrap();
    let entity_subjects = vec![
        format!("legal_entity_directors:{entity}:{version}:7"),
        format!("legal_entity_representatives:{entity}:{version}:1"),
        format!("users:{user}"),
    ];
    let registration_subjects = vec![
        format!("business_registration_co_owners:{registration}:{reg_version}:4"),
        format!("business_registration_co_owners:{registration}:{reg_version}:9"),
        format!("users:{user}"),
    ];
    (
        admin,
        entity,
        registration,
        entity_subjects,
        registration_subjects,
    )
}

async fn read(c: &Ctx, path: &str, token: &str) -> (StatusCode, Value) {
    transport::send(
        &c.service,
        transport::get(path.into(), token, transport::DIRECT_PEER, "198.51.100.99"),
    )
    .await
}

async fn scoped_reader(pool: &PgPool, admin: &Ctx) -> Ctx {
    let user = add_user(pool, admin.org, &["ADMIN"]).await;
    sqlx::query("INSERT INTO user_branches(user_id,branch_id,org_id) SELECT $1,id,org_id FROM branches WHERE org_id=$2")
        .bind(user.as_uuid()).bind(admin.org).execute(pool).await.unwrap();
    ctx(pool, admin.org, user, &["ADMIN"], None).await
}

async fn assert_record(
    pool: &PgPool,
    c: &Ctx,
    action: &str,
    target: &str,
    started: OffsetDateTime,
    subjects: &[String],
    refusal: Option<&str>,
) {
    let rows = sqlx::query("SELECT actor,occurred_at,ip::text AS ip,outcome,target_id,after_snap FROM audit_events WHERE org_id=$1 AND action=$2")
        .bind(c.org).bind(action).fetch_all(pool).await.unwrap();
    assert_eq!(
        rows.len(),
        1,
        "{action}: exactly one committed access row before the response"
    );
    let row = &rows[0];
    assert_eq!(row.get::<Uuid, _>("actor"), *c.user.as_uuid());
    assert!(row.get::<OffsetDateTime, _>("occurred_at") >= started);
    assert_eq!(row.get::<String, _>("ip"), "203.0.113.7");
    assert_eq!(row.get::<String, _>("target_id"), target);
    assert_eq!(
        row.get::<String, _>("outcome"),
        if refusal.is_some() {
            "DENIED"
        } else {
            "ALLOWED"
        }
    );
    let after: Value = row.get("after_snap");
    assert_eq!(after["subject_ids"], json!(subjects));
    assert_eq!(after["subject_count"], subjects.len());
    assert_eq!(after["principal_type"], "TENANT_USER");
    assert!(after["session_id"].as_str().is_some());
    assert_eq!(after["refusal_code"].as_str(), refusal);
    assert!(!after.to_string().contains("홍길동"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn history_records_exact_subjects_across_revisions(pool: PgPool) {
    let (admin, entity, reg, entity_subjects, reg_subjects) = world(&pool).await;
    for (path, action, target, subjects, field) in [
        (
            format!("/api/v1/legal-entities/{entity}/revisions"),
            "legal_entity.history_read",
            entity,
            entity_subjects,
            "directors",
        ),
        (
            format!("/api/v1/business-registrations/{reg}/revisions"),
            "business_registration.history_read",
            reg.to_string(),
            reg_subjects,
            "co_owners",
        ),
    ] {
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["items"].as_array().unwrap().iter().any(|r| {
            r["changes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["field"] == field)
        }));
        assert!(!body.to_string().contains("subject_refs"));
        assert_record(&pool, &admin, action, &target, started, &subjects, None).await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn masked_history_records_only_the_returned_actor_names(pool: PgPool) {
    let (admin, entity, reg, ..) = world(&pool).await;
    let reader = scoped_reader(&pool, &admin).await;
    for (path, action, target) in [
        (
            format!("/api/v1/legal-entities/{entity}/revisions"),
            "legal_entity.history_read",
            entity,
        ),
        (
            format!("/api/v1/business-registrations/{reg}/revisions"),
            "business_registration.history_read",
            reg.to_string(),
        ),
    ] {
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&reader, &path, &reader.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!body.to_string().contains("홍길동"));
        assert!(!body.to_string().contains("공동 사업자"));
        assert_record(
            &pool,
            &reader,
            action,
            &target,
            started,
            &[format!("users:{}", admin.user)],
            None,
        )
        .await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refused_history_records_the_attempt_without_personal_subjects(pool: PgPool) {
    let (admin, entity, reg, ..) = world(&pool).await;
    let user = add_user(&pool, admin.org, &["MEMBER"]).await;
    let reader = ctx(&pool, admin.org, user, &["MEMBER"], None).await;
    for (path, action, target) in [
        (
            format!("/api/v1/legal-entities/{entity}/revisions"),
            "legal_entity.history_read",
            entity,
        ),
        (
            format!("/api/v1/business-registrations/{reg}/revisions"),
            "business_registration.history_read",
            reg.to_string(),
        ),
    ] {
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&reader, &path, &reader.token).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_record(
            &pool,
            &reader,
            action,
            &target,
            started,
            &[],
            body["error"]["code"].as_str(),
        )
        .await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_history_records_the_refusal(pool: PgPool) {
    let (admin, ..) = world(&pool).await;
    for (route, action) in [
        ("legal-entities", "legal_entity.history_read"),
        (
            "business-registrations",
            "business_registration.history_read",
        ),
    ] {
        let id = Uuid::new_v4();
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(
            &admin,
            &format!("/api/v1/{route}/{id}/revisions"),
            &admin.token,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_record(
            &pool,
            &admin,
            action,
            &id.to_string(),
            started,
            &[],
            body["error"]["code"].as_str(),
        )
        .await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn document_image_refusal_is_recorded_before_the_403(pool: PgPool) {
    for role in ["ADMIN", "MEMBER"] {
        let (admin, ..) = world(&pool).await;
        let reader = if role == "ADMIN" {
            scoped_reader(&pool, &admin).await
        } else {
            let user = add_user(&pool, admin.org, &[role]).await;
            ctx(&pool, admin.org, user, &[role], None).await
        };
        let doc = Uuid::new_v4();
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(
            &reader,
            &format!("/api/v1/entity-documents/{doc}/content"),
            &reader.token,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_record(
            &pool,
            &reader,
            "entity_document.read",
            &doc.to_string(),
            started,
            &[],
            Some("forbidden"),
        )
        .await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn history_refuses_anonymous_and_fails_closed_if_logging_fails(pool: PgPool) {
    let (admin, entity, reg, ..) = world(&pool).await;
    let paths = [
        format!("/api/v1/legal-entities/{entity}/revisions"),
        format!("/api/v1/business-registrations/{reg}/revisions"),
    ];
    for path in &paths {
        assert_eq!(read(&admin, path, "").await.0, StatusCode::UNAUTHORIZED);
    }
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action LIKE '%.history_read'",
    )
    .bind(admin.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows, 0);
    sqlx::query("CREATE FUNCTION reject_history_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('legal_entity.history_read','business_registration.history_read','entity_document.read') THEN RAISE EXCEPTION 'access log unavailable'; END IF; RETURN NEW; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_history_access BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_access()").execute(&pool).await.unwrap();
    for roles in [&["SUPER_ADMIN"][..], &["MEMBER"][..]] {
        let user = if roles == ["SUPER_ADMIN"] {
            admin.user
        } else {
            add_user(&pool, admin.org, roles).await
        };
        let reader = ctx(&pool, admin.org, user, roles, None).await;
        for path in &paths {
            assert_eq!(
                read(&reader, path, &reader.token).await.0,
                StatusCode::INTERNAL_SERVER_ERROR,
                "{path}"
            );
        }
    }
    let reader = scoped_reader(&pool, &admin).await;
    assert_eq!(
        read(
            &reader,
            &format!("/api/v1/entity-documents/{}/content", Uuid::new_v4()),
            &reader.token
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
}
