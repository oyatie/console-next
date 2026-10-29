// SPDX-License-Identifier: LicenseRef-Proprietary
//! Contact-only reads, masking, and embedded workplace subjects.
use super::*;

async fn contact_world(pool: &PgPool) -> (Ctx, String, String, i32) {
    let (admin, entity, workplace, version) = world(pool).await;
    let registration: Uuid =
        sqlx::query_scalar("SELECT registration_id FROM workplaces WHERE id=$1")
            .bind(Uuid::parse_str(&workplace).unwrap())
            .fetch_one(pool)
            .await
            .unwrap();
    let (status, revised) = admin.call("PUT", &format!("/api/v1/workplaces/{workplace}"), Some(json!({
        "expected_version":version, "effective_from":support::today_kst(), "reason_code":"CORRECTION",
        "name":"본사", "registration_id":registration, "same_address_as_registration":true,
        "opened_on":"2020-03-02", "status":"CONTINUING",
        "mobile":"010-1234-5678", "email":"workplace@example.com",
    }))).await;
    assert_eq!(status, StatusCode::OK, "{revised}");
    assert!(revised["record"]["current"]["representative_name"].is_null());
    let version = revised["record"]["current"]["version"].as_i64().unwrap() as i32;
    (admin, entity, workplace, version)
}

async fn assert_contact_read(pool: PgPool, index: usize) {
    let (admin, entity, workplace, version) = contact_world(&pool).await;
    let (path, action, target) = cases(&entity, &workplace).remove(index);
    let started = OffsetDateTime::now_utc();
    let (status, body) = read(&admin, &path, &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.to_string().contains("workplace@example.com"));
    let mut subjects = vec![format!("workplace_revisions:{workplace}:{version}")];
    if action == "workplace.history_read" {
        subjects.extend([
            format!("users:{}", admin.user),
            format!("workplace_revisions:{workplace}:{}", version - 1),
        ]);
    }
    subjects.sort();
    assert_record(&pool, &admin, action, &target, started, &subjects, None).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn contact_only_detail_records_subjects(pool: PgPool) {
    assert_contact_read(pool, 0).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn contact_only_list_records_subjects(pool: PgPool) {
    assert_contact_read(pool, 1).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn contact_only_entity_workplace_list_records_subjects(pool: PgPool) {
    assert_contact_read(pool, 2).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn contact_only_history_records_subjects(pool: PgPool) {
    assert_contact_read(pool, 3).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn contact_history_is_masked_without_personal_access(pool: PgPool) {
    let (admin, entity, workplace, _) = contact_world(&pool).await;
    let user = add_user(&pool, admin.org, &["ADMIN"]).await;
    sqlx::query("INSERT INTO user_branches(user_id,branch_id,org_id) SELECT $1,id,org_id FROM branches WHERE org_id=$2")
        .bind(user.as_uuid()).bind(admin.org).execute(&pool).await.unwrap();
    let reader = ctx(&pool, admin.org, user, &["ADMIN"], None).await;
    for (path, action, target) in cases(&entity, &workplace) {
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&reader, &path, &reader.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            !body.to_string().contains("workplace@example.com"),
            "{path}: {body}"
        );
        for mobile in ["010-1234-5678", "+821012345678"] {
            assert!(!body.to_string().contains(mobile), "{path}: {body}");
        }
        if action == "workplace.history_read" {
            assert!(body["items"].as_array().unwrap().iter().all(|entry| {
                entry["changes"].as_array().unwrap().iter().all(|change| {
                    !["representative_name", "mobile", "email"]
                        .contains(&change["field"].as_str().unwrap())
                })
            }));
        }
        let subjects = if action == "workplace.history_read" {
            vec![format!("users:{}", admin.user)]
        } else {
            vec![]
        };
        assert_record(&pool, &reader, action, &target, started, &subjects, None).await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_reads_keep_embedded_contact_only_workplace_subjects(pool: PgPool) {
    let (admin, entity, workplace, version) = contact_world(&pool).await;
    for (path, action) in [
        (
            format!("/api/v1/legal-entities/{entity}"),
            "legal_entity.read",
        ),
        ("/api/v1/legal-entities".into(), "legal_entity.list_read"),
    ] {
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.to_string().contains("workplace@example.com"));
        let rows: Vec<Value> = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action=$2 AND occurred_at >= $3")
            .bind(admin.org).bind(action).bind(started).fetch_all(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0]["subject_ids"]
                .as_array()
                .unwrap()
                .contains(&json!(format!("workplace_revisions:{workplace}:{version}")))
        );
    }
}
