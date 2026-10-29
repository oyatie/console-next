// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Workplace reads commit one access event for exactly the people returned.
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

#[path = "workplace_access_log/contacts.rs"]
mod contacts;

async fn world(pool: &PgPool) -> (Ctx, String, String, i32) {
    let (org, user) = tenant(pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, ..) = structure(&admin).await;
    let registration: Uuid =
        sqlx::query_scalar("SELECT registration_id FROM workplaces WHERE id=$1")
            .bind(Uuid::parse_str(&workplace).unwrap())
            .fetch_one(pool)
            .await
            .unwrap();
    let (status, revised) = admin.call("PUT", &format!("/api/v1/workplaces/{workplace}"), Some(json!({
        "expected_version":1, "effective_from":support::today_kst(), "reason_code":"CORRECTION",
        "name":"본사", "registration_id":registration, "same_address_as_registration":true,
        "opened_on":"2020-03-02", "status":"CONTINUING", "representative_name":"사업장 대표자",
    }))).await;
    assert_eq!(status, StatusCode::OK, "{revised}");
    let version = revised["record"]["current"]["version"].as_i64().unwrap() as i32;
    (admin, entity, workplace, version)
}

fn cases(entity: &str, workplace: &str) -> Vec<(String, &'static str, String)> {
    vec![
        (
            format!("/api/v1/workplaces/{workplace}"),
            "workplace.read",
            workplace.into(),
        ),
        (
            "/api/v1/workplaces".into(),
            "workplace.list_read",
            "query".into(),
        ),
        (
            format!("/api/v1/legal-entities/{entity}/workplaces"),
            "workplace.list_read",
            entity.into(),
        ),
        (
            format!("/api/v1/workplaces/{workplace}/revisions"),
            "workplace.history_read",
            workplace.into(),
        ),
    ]
}

async fn read(c: &Ctx, path: &str, token: &str) -> (StatusCode, Value) {
    transport::send(
        &c.service,
        transport::get(path.into(), token, transport::DIRECT_PEER, "198.51.100.99"),
    )
    .await
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
    let rows = sqlx::query("SELECT actor,occurred_at,ip::text AS ip,target_type,target_id,outcome,after_snap FROM audit_events WHERE org_id=$1 AND action=$2 AND occurred_at >= $3")
        .bind(c.org).bind(action).bind(started).fetch_all(pool).await.unwrap();
    assert_eq!(rows.len(), 1, "{action}: exactly one committed access row");
    let row = &rows[0];
    assert_eq!(row.get::<Uuid, _>("actor"), *c.user.as_uuid());
    assert!(row.get::<OffsetDateTime, _>("occurred_at") >= started);
    assert_eq!(row.get::<String, _>("ip"), "203.0.113.7");
    assert_eq!(row.get::<String, _>("target_type"), "workplace");
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
    assert!(!after.to_string().contains("사업장 대표자"));
}

async fn assert_read(pool: PgPool, index: usize) {
    let (admin, entity, workplace, version) = world(&pool).await;
    let (path, action, target) = cases(&entity, &workplace).remove(index);
    let started = OffsetDateTime::now_utc();
    let (status, body) = read(&admin, &path, &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    assert!(body.to_string().contains("사업장 대표자"));
    let mut subjects = vec![format!("workplace_revisions:{workplace}:{version}")];
    if action == "workplace.history_read" {
        subjects.push(format!("users:{}", admin.user));
    }
    subjects.sort();
    assert_record(&pool, &admin, action, &target, started, &subjects, None).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_detail_records_subjects(pool: PgPool) {
    assert_read(pool, 0).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_list_records_subjects(pool: PgPool) {
    assert_read(pool, 1).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_workplace_list_records_subjects(pool: PgPool) {
    assert_read(pool, 2).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_history_records_subjects(pool: PgPool) {
    assert_read(pool, 3).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_lists_record_only_the_returned_scope(pool: PgPool) {
    let (admin, entity, workplace, version) = world(&pool).await;
    let mut input = support::entity_body();
    input["name"] = json!("다른 법인");
    input["crn"] = Value::Null;
    input["founding"] = json!(true);
    let (status, other) = admin
        .call("POST", "/api/v1/legal-entities", Some(input))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{other}");
    let other = other["record"]["id"].as_str().unwrap();
    let (status, hidden) = admin.call("POST", &format!("/api/v1/legal-entities/{other}/workplaces"), Some(json!({"name":"다른 사업장","address":support::address(),"opened_on":"2020-03-02","representative_name":"다른 사업장 대표자","insurance":{"shortcut":"ALL_ESTABLISHED_NUMBERS_LATER"}}))).await;
    assert_eq!(status, StatusCode::CREATED, "{hidden}");
    let user = add_user(&pool, admin.org, &["ADMIN"]).await;
    sqlx::query("INSERT INTO user_branches(user_id,branch_id,org_id) SELECT $1,default_branch_id,org_id FROM workplaces WHERE id=$2")
        .bind(user.as_uuid()).bind(Uuid::parse_str(&workplace).unwrap()).execute(&pool).await.unwrap();
    let reader = ctx(&pool, admin.org, user, &["ADMIN"], None).await;
    for c in [&admin, &reader] {
        for path in [
            format!("/api/v1/legal-entities/{entity}/workplaces"),
            "/api/v1/workplaces".into(),
        ] {
            // The tenant-wide admin sees both; the scoped reader sees only its workplace.
            let started = OffsetDateTime::now_utc();
            let (status, body) = read(c, &path, &c.token).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let items = body["items"].as_array().unwrap();
            let mut subjects = vec![format!("workplace_revisions:{workplace}:{version}")];
            let count = if c.user == admin.user && path == "/api/v1/workplaces" {
                subjects.push(format!(
                    "workplace_revisions:{}:{}",
                    hidden["record"]["id"].as_str().unwrap(),
                    hidden["record"]["current"]["version"].as_i64().unwrap()
                ));
                2
            } else {
                1
            };
            assert_eq!(items.len(), count);
            if c.user != admin.user {
                subjects.clear();
            }
            subjects.sort();
            assert_record(
                &pool,
                c,
                "workplace.list_read",
                if path == "/api/v1/workplaces" {
                    "query"
                } else {
                    &entity
                },
                started,
                &subjects,
                None,
            )
            .await;
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn masked_workplace_reads_log_only_displayed_people(pool: PgPool) {
    let (admin, entity, workplace, _) = world(&pool).await;
    let user = add_user(&pool, admin.org, &["ADMIN"]).await;
    sqlx::query("INSERT INTO user_branches(user_id,branch_id,org_id) SELECT $1,id,org_id FROM branches WHERE org_id=$2")
        .bind(user.as_uuid()).bind(admin.org).execute(&pool).await.unwrap();
    let reader = ctx(&pool, admin.org, user, &["ADMIN"], None).await;
    // Entity-scoped authority is needed to see this workplace's restricted fields.
    for (path, action, target) in cases(&entity, &workplace) {
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&reader, &path, &reader.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!body.to_string().contains("사업장 대표자"));
        let subjects = if action == "workplace.history_read" {
            vec![format!("users:{}", admin.user)]
        } else {
            vec![]
        };
        assert_record(&pool, &reader, action, &target, started, &subjects, None).await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_history_and_detail_record_refused_attempts(pool: PgPool) {
    let (admin, _, workplace, _) = world(&pool).await;
    let user = add_user(&pool, admin.org, &["MEMBER"]).await;
    let reader = ctx(&pool, admin.org, user, &["MEMBER"], None).await;
    for (c, id, expected) in [
        (&reader, workplace, StatusCode::FORBIDDEN),
        (&admin, Uuid::new_v4().to_string(), StatusCode::NOT_FOUND),
    ] {
        for (suffix, action) in [
            ("", "workplace.read"),
            ("/revisions", "workplace.history_read"),
        ] {
            let started = OffsetDateTime::now_utc();
            let (status, body) =
                read(c, &format!("/api/v1/workplaces/{id}{suffix}"), &c.token).await;
            assert_eq!(status, expected, "{body}");
            assert_record(
                &pool,
                c,
                action,
                &id,
                started,
                &[],
                body["error"]["code"].as_str(),
            )
            .await;
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_reads_refuse_anonymous_and_fail_closed(pool: PgPool) {
    let (admin, entity, workplace, _) = world(&pool).await;
    for (path, _, _) in cases(&entity, &workplace) {
        assert_eq!(read(&admin, &path, "").await.0, StatusCode::UNAUTHORIZED);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action IN ('workplace.read','workplace.list_read','workplace.history_read')")
        .bind(admin.org).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 0);
    sqlx::query("CREATE FUNCTION reject_workplace_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('workplace.read','workplace.list_read','workplace.history_read') THEN RAISE EXCEPTION 'access log unavailable'; END IF; RETURN NEW; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_workplace_access BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_workplace_access()").execute(&pool).await.unwrap();
    for (path, _, _) in cases(&entity, &workplace) {
        assert_eq!(
            read(&admin, &path, &admin.token).await.0,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{path}"
        );
    }
}
