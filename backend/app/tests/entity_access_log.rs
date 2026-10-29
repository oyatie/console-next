// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Entity reads use the shared writer, including immutable evidence subject references.
#[path = "support/http.rs"]
mod support;
#[path = "access_log_reads/support.rs"]
mod transport;

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use support::{Ctx, ctx, structure, tenant};
use time::OffsetDateTime;
use uuid::Uuid;

async fn world(pool: &PgPool) -> (Ctx, String, Uuid, String, i32) {
    let (org, user) = tenant(pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, _, branch, unit) = structure(&admin).await;
    let (status, hired) = admin
        .call(
            "POST",
            "/api/v1/employees",
            Some(support::employee_body("LOG-1", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{hired}");
    let employee = hired["employee"]["id"].as_str().unwrap().to_owned();
    let doc = Uuid::new_v4();
    sqlx::query("INSERT INTO entity_documents(org_id,id,kind,file_name,content_type,byte_size,sha256,content,retention_key,uploaded_by,legal_entity_id) VALUES($1,$2,'BIZ_REG_CERT','증명.png','image/png',8,sha256($3),$3,'retention.entity_registration_document',$4,$5)")
        .bind(org).bind(doc).bind(b"\x89PNG\r\n\x1a\n".as_slice()).bind(user.as_uuid()).bind(Uuid::parse_str(&entity).unwrap()).execute(pool).await.unwrap();
    let (revision, version): (Uuid, i32) = sqlx::query_as("SELECT id,version FROM legal_entity_revisions WHERE legal_entity_id=$1 ORDER BY version DESC LIMIT 1")
        .bind(Uuid::parse_str(&entity).unwrap()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_directors(org_id,revision_id,seq,role,name) VALUES($1,$2,1,'AUDITOR','감사 담당자')")
        .bind(org).bind(revision).execute(pool).await.unwrap();
    (admin, entity, doc, employee, version)
}

fn cases(
    entity: &str,
    doc: Uuid,
    employee: &str,
    version: i32,
) -> Vec<(String, &'static str, Vec<String>)> {
    let refs = vec![
        format!("legal_entity_directors:{entity}:{version}:1"),
        format!("legal_entity_representatives:{entity}:{version}:1"),
    ];
    vec![
        (
            "/api/v1/employees/export.csv?export_purpose=INTERNAL_REVIEW".into(),
            "employee.export",
            vec![employee.into()],
        ),
        (
            "/api/v1/employees/export.csv?layout=register&export_purpose=INTERNAL_REVIEW".into(),
            "employee.export",
            vec![employee.into()],
        ),
        (
            format!("/api/v1/legal-entities/{entity}"),
            "legal_entity.read",
            refs.clone(),
        ),
        (
            "/api/v1/legal-entities".into(),
            "legal_entity.list_read",
            refs,
        ),
        (
            format!("/api/v1/legal-entities/{entity}/documents"),
            "entity_document.list_read",
            vec![format!("entity_documents:{doc}")],
        ),
        (
            format!("/api/v1/entity-documents/{doc}"),
            "entity_document.metadata_read",
            vec![format!("entity_documents:{doc}")],
        ),
        (
            format!("/api/v1/entity-documents/{doc}/content"),
            "entity_document.read",
            vec![format!("entity_documents:{doc}")],
        ),
    ]
}

async fn read(admin: &Ctx, path: &str, token: &str) -> (StatusCode, Value) {
    transport::send(
        &admin.service,
        transport::get(path.into(), token, transport::DIRECT_PEER, "198.51.100.99"),
    )
    .await
}

async fn assert_read(pool: PgPool, index: usize) {
    let (admin, entity, doc, employee, version) = world(&pool).await;
    let (path, action, subjects) = cases(&entity, doc, &employee, version).remove(index);
    let before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action=$2")
            .bind(admin.org)
            .bind(action)
            .fetch_one(&pool)
            .await
            .unwrap();
    let started = OffsetDateTime::now_utc();
    let (status, body) = read(&admin, &path, &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    let rows = sqlx::query("SELECT actor,occurred_at,ip::text AS ip,after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC")
        .bind(admin.org).bind(action).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len() as i64, before + 1, "{path}");
    let row = &rows[0];
    assert_eq!(row.get::<Uuid, _>("actor"), *admin.user.as_uuid());
    assert!(row.get::<OffsetDateTime, _>("occurred_at") >= started);
    assert_eq!(row.get::<String, _>("ip"), "203.0.113.7");
    let after: Value = row.get("after_snap");
    assert_eq!(after["subject_ids"], json!(subjects), "{path}");
    assert_eq!(after["subject_count"], subjects.len());
    assert_eq!(after["principal_type"], "TENANT_USER");
    assert!(after["session_id"].as_str().is_some());
    assert_eq!(after["self_read"], false);
    if action == "employee.export" {
        assert_eq!(after["export_purpose"], "INTERNAL_REVIEW");
    }
    if action == "entity_document.read" {
        assert_eq!(after["kind"], "BIZ_REG_CERT");
    }
    assert!(!after.to_string().contains("홍길동"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn standard_export_records_subjects(pool: PgPool) {
    assert_read(pool, 0).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_export_records_subjects(pool: PgPool) {
    assert_read(pool, 1).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_detail_records_subjects(pool: PgPool) {
    assert_read(pool, 2).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_list_records_subjects(pool: PgPool) {
    assert_read(pool, 3).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn document_list_records_subjects(pool: PgPool) {
    assert_read(pool, 4).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn document_metadata_records_subjects(pool: PgPool) {
    assert_read(pool, 5).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn document_image_records_subjects(pool: PgPool) {
    assert_read(pool, 6).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_reads_refuse_anonymous_and_fail_closed_when_access_record_fails(pool: PgPool) {
    let (admin, entity, doc, employee, version) = world(&pool).await;
    for (path, _, _) in cases(&entity, doc, &employee, version) {
        assert_eq!(read(&admin, &path, "").await.0, StatusCode::UNAUTHORIZED);
    }
    let anonymous: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND actor IS NULL")
            .bind(admin.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(anonymous, 0);
    sqlx::query("CREATE FUNCTION reject_entity_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('legal_entity.read','legal_entity.list_read','entity_document.list_read','entity_document.metadata_read','entity_document.read','employee.export') THEN RAISE EXCEPTION 'access log unavailable'; END IF; RETURN NEW; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_entity_access BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_entity_access()").execute(&pool).await.unwrap();
    for (path, _, _) in cases(&entity, doc, &employee, version) {
        assert_eq!(
            read(&admin, &path, &admin.token).await.0,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{path}"
        );
    }
}
