// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod rights_intake_support;
mod settings_support;
use console_app::build_router;
use console_compliance_adapter_postgres::{PgComplianceStore, rights};
use console_kernel_core::OrgId;
use console_platform_test_support::seed_org_and_super_admin;
use http::StatusCode;
use serde_json::{Value, json};
use settings_support::*;
use sqlx::PgPool;
use uuid::Uuid;

async fn assert_intake(pool: PgPool) {
    let org = OrgId::new();
    let subject = seed_org_and_super_admin(&pool, *org.as_uuid(), "rights-intake").await;
    let (handler, grant) = rights_intake_support::hr_handler(&pool, org, subject).await;
    sqlx::query("UPDATE statutory_rules SET value_num=17 WHERE code='PIPA_ACCESS_RESPONSE_DAYS'")
        .execute(&pool)
        .await
        .unwrap();
    let rt = runtime_pool(&pool).await;
    let register = PgComplianceStore::new(rt.clone())
        .statutory_register()
        .await
        .unwrap();
    let mut tx = rights::begin(&rt, org).await.unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'Privacy','Subject','privacy.xlsx','People',1,'subject') RETURNING id")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    let input =
        serde_json::from_value(json!({"controller":"TENANT","kinds":["ACCESS"],"detail":""}))
            .unwrap();
    let first = rights::file(&mut tx, org, subject, Some(employee), &input, &register)
        .await
        .unwrap();
    let second = rights::file(&mut tx, org, subject, Some(employee), &input, &register)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let keys = keys();
    let bearer = token(&pool, &keys, *org.as_uuid(), handler, "MEMBER").await;
    let service = build_router(app_state(rt.clone(), keys.1.clone()).unwrap());
    let path = "/api/v1/me/action-inbox?limit=1";
    let (status, page) = send(&service, "GET", path, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["unavailable"], json!([]), "{page}");
    let rows = page["items"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        1,
        "a filed request must reach a handler: {page}; filed: {first}, {second}"
    );
    assert_eq!(rows[0]["kind"], "privacy_request");
    let name = "Admin rights-intake";
    assert_eq!(rows[0]["who"], name);
    assert_eq!(rows[0]["context"]["privacy_kinds"], json!(["ACCESS"]));
    let receipt_path = format!(
        "/api/v1/privacy/rights-requests/{}",
        first["id"].as_str().unwrap()
    );
    let (status, receipt) = send(&service, "GET", &receipt_path, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["request"], first);
    assert_eq!(receipt["subject_name"], name);
    assert_eq!(rows[0]["lane"], "turn");
    assert_eq!(rows[0]["days_remaining"], 17);
    assert_eq!(
        &rows[0]["due"].as_str().unwrap()[..10],
        first["kinds"]["ACCESS"]["due"]["on"].as_str().unwrap()
    );
    assert!(page["has_work"].as_bool().unwrap());
    assert!(
        page["available_filters"]
            .as_array()
            .unwrap()
            .contains(&json!("turn"))
    );
    let next = page["next_cursor"].as_str().unwrap();
    let mut tx = rights::begin(&rt, org).await.unwrap();
    rights::file(&mut tx, org, subject, Some(employee), &input, &register)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (status, next_page) = send(
        &service,
        "GET",
        &format!("{path}&cursor={next}"),
        Some(&bearer),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{next_page}");
    assert_eq!(
        next_page["total"], page["total"],
        "snapshot totals must exclude a later filing"
    );
    assert_ne!(rows[0]["id"], next_page["items"][0]["id"]);
    let mut actual = vec![rows[0]["ref"].clone(), next_page["items"][0]["ref"].clone()];
    let mut cursor = next_page["next_cursor"].as_str().map(str::to_owned);
    while let Some(next) = cursor {
        let (status, page) = send(
            &service,
            "GET",
            &format!("{path}&cursor={next}"),
            Some(&bearer),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["unavailable"], json!([]), "{page}");
        actual.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["kind"] == "privacy_request")
                .map(|row| row["ref"].clone()),
        );
        cursor = page["next_cursor"].as_str().map(str::to_owned);
    }
    actual.sort_by_key(Value::to_string);
    let mut expected = vec![first["receipt_no"].clone(), second["receipt_no"].clone()];
    expected.sort_by_key(Value::to_string);
    assert_eq!(actual, expected);
    sqlx::query("UPDATE privacy_rights_requests SET body=jsonb_set(body,'{status}','\"DECIDED\"') WHERE org_id=$1")
        .bind(org.as_uuid()).execute(&pool).await.unwrap();
    let (_, closed) = send(&service, "GET", path, Some(&bearer), None).await;
    assert!(
        !closed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "privacy_request"),
        "completed requests leave the intake: {closed}"
    );
    sqlx::query("UPDATE privacy_rights_requests SET body=jsonb_set(body,'{status}','\"RECEIVED\"') WHERE org_id=$1")
        .bind(org.as_uuid()).execute(&pool).await.unwrap();
    let entity = seed_legal_entity(&pool, *org.as_uuid(), subject).await;
    let scoped_handler = seed_user(&pool, *org.as_uuid(), "MEMBER").await;
    sqlx::query("INSERT INTO access_grants(org_id,id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT org_id,gen_random_uuid(),$2,role_id,'LEGAL_ENTITY',$3,valid_from,true,'SETUP','TEST',granted_by FROM access_grants WHERE id=$1")
        .bind(grant).bind(scoped_handler.as_uuid()).bind(entity).execute(&pool).await.unwrap();
    let scoped_token = token(&pool, &keys, *org.as_uuid(), scoped_handler, "MEMBER").await;
    let (status, scoped) = send(&service, "GET", path, Some(&scoped_token), None).await;
    assert_eq!(status, StatusCode::OK, "{scoped}");
    assert!(
        !scoped["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "privacy_request"),
        "unplaced requests require tenant scope: {scoped}"
    );
    let employee = rights_intake_support::placed_employee(&pool, org, subject, entity).await;
    let mut tx = rights::begin(&rt, org).await.unwrap();
    let hr_input = serde_json::from_value(
        json!({"controller":"TENANT","kinds":["ACCESS"],"detail":"My HR records"}),
    )
    .unwrap();
    let hr = rights::file(&mut tx, org, subject, Some(employee), &hr_input, &register)
        .await
        .unwrap();
    let account = serde_json::from_value(
        json!({"controller":"OPERATOR","kinds":["ACCESS"],"detail":"Private account detail"}),
    )
    .unwrap();
    let operator = rights::file(&mut tx, org, subject, Some(employee), &account, &register)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (_, tenant) = send(
        &service,
        "GET",
        "/api/v1/me/action-inbox",
        Some(&bearer),
        None,
    )
    .await;
    assert!(
        !tenant["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["ref"] == operator["receipt_no"]),
        "operator requests must never reach tenant HR: {tenant}"
    );
    let (status, _) = send(
        &service,
        "GET",
        &format!(
            "/api/v1/privacy/rights-requests/{}",
            operator["id"].as_str().unwrap()
        ),
        Some(&bearer),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, scoped) = send(
        &service,
        "GET",
        "/api/v1/me/action-inbox?filter=turn",
        Some(&scoped_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{scoped}");
    let visible: Vec<_> = scoped["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "privacy_request")
        .map(|row| row["ref"].clone())
        .collect();
    assert_eq!(
        visible,
        vec![hr["receipt_no"].clone()],
        "scoped handlers see HR receipts in their scope, not account receipts: {scoped}"
    );
    let (status, _) = send(&service, "GET", &receipt_path, Some(&scoped_token), None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "out-of-scope receipt must stay hidden"
    );
    let (status, receipt) = send(
        &service,
        "GET",
        &format!(
            "/api/v1/privacy/rights-requests/{}",
            hr["id"].as_str().unwrap()
        ),
        Some(&scoped_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["request"], hr);
    // A token minted before revocation must not retain inbox visibility or counts.
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE id=$1",
    )
    .bind(grant)
    .bind(subject.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let (_, refused) = send(&service, "GET", path, Some(&bearer), None).await;
    assert_eq!(refused["items"], json!([]), "{refused}");
    assert_eq!(refused["counts"]["turn"]["total"], 0);
    let (status, _) = send(&service, "GET", &receipt_path, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let foreign = OrgId::new();
    let outsider = seed_org_and_super_admin(&pool, *foreign.as_uuid(), "rights-other").await;
    let bearer = token(&pool, &keys, *foreign.as_uuid(), outsider, "SUPER_ADMIN").await;
    let (_, page) = send(&service, "GET", path, Some(&bearer), None).await;
    assert!(
        !page["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "privacy_request"),
        "{page}"
    );
    let (status, _) = send(&service, "GET", &receipt_path, Some(&bearer), None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "foreign tenant receipt must stay hidden"
    );
    let non_handler = seed_user(&pool, *org.as_uuid(), "MEMBER").await;
    let bearer = token(&pool, &keys, *org.as_uuid(), non_handler, "MEMBER").await;
    sqlx::query("REVOKE SELECT ON privacy_rights_requests FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = send(&service, "GET", &receipt_path, Some(&bearer), None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "non-handler must not read the store"
    );
    let (_, page) = send(&service, "GET", path, Some(&bearer), None).await;
    assert!(
        !page["has_work"].as_bool().unwrap(),
        "non-handler must not receive work affordances: {page}"
    );
    assert_eq!(
        page["unavailable"],
        json!([]),
        "a refused handler must not read the request store: {page}"
    );
    assert_eq!(
        page["items"],
        json!([]),
        "a non-handler must see no requests: {page}"
    );
}
