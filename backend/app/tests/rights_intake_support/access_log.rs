// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn intake_receipt_records_access_before_revealing_personal_data(pool: PgPool) {
    let org = OrgId::new();
    let subject = seed_org_and_super_admin(&pool, *org.as_uuid(), "privacy-access").await;
    let (handler, _) = rights_intake_support::hr_handler(&pool, org, subject).await;
    let non_handler = seed_user(&pool, *org.as_uuid(), "MEMBER").await;
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'Privacy','Subject','privacy.xlsx','People',1,'subject') RETURNING id")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    let rt = runtime_pool(&pool).await;
    let register = PgComplianceStore::new(rt.clone())
        .statutory_register()
        .await
        .unwrap();
    let input = serde_json::from_value(
        json!({"controller":"TENANT","kinds":["ACCESS"],"detail":"My private records"}),
    )
    .unwrap();
    let mut tx = rights::begin(&rt, org).await.unwrap();
    let receipt = rights::file(&mut tx, org, subject, Some(employee), &input, &register)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let path = format!(
        "/api/v1/privacy/rights-requests/{}",
        receipt["id"].as_str().unwrap()
    );
    let keys = keys();
    let bearer = token(&pool, &keys, *org.as_uuid(), handler, "MEMBER").await;
    let refused = token(&pool, &keys, *org.as_uuid(), non_handler, "MEMBER").await;
    let service = build_router(app_state(rt, keys.1).unwrap());
    let (status, body) = send(&service, "GET", &path, Some(&refused), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='privacy_request.intake_read'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(
        rows, 0,
        "a refused reader must not produce an access record"
    );

    let started = time::OffsetDateTime::now_utc();
    let (status, body) = send(&service, "GET", &path, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["request"], receipt);
    assert_eq!(body["subject_name"], "Admin privacy-access");
    let rows: Vec<(Uuid, String, String, time::OffsetDateTime, Value)> = sqlx::query_as("SELECT actor,target_type,target_id,occurred_at,after_snap FROM audit_events WHERE org_id=$1 AND action='privacy_request.intake_read'")
        .bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
    assert_eq!(
        rows.len(),
        1,
        "one handler read must write exactly one access record"
    );
    let (actor, target_type, target_id, occurred_at, after) = &rows[0];
    assert_eq!(*actor, *handler.as_uuid());
    assert_eq!(target_type, "privacy_rights_request");
    assert_eq!(target_id, receipt["id"].as_str().unwrap());
    assert!(*occurred_at >= started);
    assert_eq!(after["subject_ids"], json!([subject]));
    assert_eq!(after["subject_count"], 1);
    assert_eq!(after["self_read"], false);
    assert_eq!(after["principal_type"], "TENANT_USER");
    assert!(after["session_id"].as_str().is_some());
    assert!(!after.to_string().contains("My private records"));
    assert!(!after.to_string().contains("Admin privacy-access"));

    sqlx::query("CREATE FUNCTION reject_privacy_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='privacy_request.intake_read' THEN RAISE EXCEPTION 'access log unavailable'; END IF; RETURN NEW; END $$")
        .execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_privacy_access BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_privacy_access()")
        .execute(&pool).await.unwrap();
    let (status, body) = send(&service, "GET", &path, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(
        body.get("request").is_none(),
        "failed auditing must withhold the receipt: {body}"
    );
    assert!(!body.to_string().contains("My private records"));
    assert!(!body.to_string().contains("Admin privacy-access"));
}
