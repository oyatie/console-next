// SPDX-License-Identifier: LicenseRef-Proprietary
#![cfg(feature = "compliance")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

fn served(body: &Value, key: &str) -> bool {
    body["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|cap| cap["feature"] == key)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn evidence_commands_keep_provenance_and_authorize_the_effective_tenant(pool: PgPool) {
    let (org, actor) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (other_org, other_actor) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = http::ctx(&pool, org, actor, &["SUPER_ADMIN"], None).await;
    let other = http::ctx(&pool, other_org, other_actor, &["SUPER_ADMIN"], None).await;
    let employee = http::add_user(&pool, org, &["MEMBER"]).await;
    let restricted = http::ctx(&pool, org, employee, &["MEMBER"], None).await;
    let path = "/api/v1/compliance/evidence-bindings";
    let caps = "/api/v1/me/authz";
    let available = [
        "served_compliance_evidence",
        "served_compliance_evidence_link",
        "served_compliance_evidence_accept",
    ];
    let (_, before) = admin.call("GET", caps, None).await;
    assert!(available.iter().all(|key| !served(&before, key)));
    for tenant in [org, other_org] {
        sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,'compliance',true,'synthetic evidence flow')")
            .bind(tenant).execute(&pool).await.unwrap();
    }
    let (_, after) = admin.call("GET", caps, None).await;
    assert!(available.iter().all(|key| served(&after, key)));
    let (_, denied) = restricted.call("GET", caps, None).await;
    assert!(available.iter().all(|key| !served(&denied, key)));
    let reader = http::add_user(&pool, org, &["EXECUTIVE"]).await;
    let reader = http::ctx(&pool, org, reader, &["EXECUTIVE"], None).await;
    let (_, reader_caps) = reader.call("GET", caps, None).await;
    assert!(served(&reader_caps, available[0]));
    assert!(!served(&reader_caps, available[1]));
    assert!(!served(&reader_caps, available[2]));
    assert_eq!(reader.call("GET", path, None).await.0, StatusCode::OK);
    let (status, fw) = admin.call("POST", "/api/v1/compliance/frameworks", Some(json!({"name":"Training review","version_label":"1","framework_kind":"INTERNAL_CONTROL"}))).await;
    assert_eq!(status, StatusCode::OK, "{fw}");
    let (status, control) = admin.call("POST", "/api/v1/compliance/framework-controls", Some(json!({"framework_id":fw["id"],"title":"Training evidence","control_key":"TRAINING","objective":"Record attendance evidence","control_type":"DETECTIVE","evidence_requirements":[{"kind":"training_register"}]}))).await;
    assert_eq!(status, StatusCode::OK, "{control}");
    assert_eq!(
        control["evidence_requirements"],
        json!([{"kind":"training_register"}])
    );
    let body = json!({"control_id":control["id"],"evidence_target_type":"external_document","evidence_target_id":"Synthetic attendance sheet","confidence":"HIGH","valid_from":"2026-01-01","hash_sha256":"ab".repeat(32)});
    let (status, proposed) = admin.call("POST", path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{proposed}");
    assert_eq!(proposed["valid_from"], "2026-01-01");
    assert_eq!(proposed["status"], "PROPOSED");
    assert_eq!(proposed["metadata"], json!({}));
    let (status, replay) = admin.retry("POST", path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::CONFLICT, "{replay}");
    assert_eq!(replay["error"]["code"], "command_applied");
    assert_eq!(
        http::audits(&pool, org, "compliance.evidence_binding.create").await,
        1
    );
    let accept = format!("{path}/{}/accept", proposed["id"].as_str().unwrap());
    for (method, uri, data) in [
        ("GET", path, None),
        ("POST", path, Some(body)),
        ("POST", accept.as_str(), None),
    ] {
        assert_eq!(
            restricted.call(method, uri, data).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        reader.call("POST", &accept, None).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, other_list) = other.call("GET", path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(other_list["total"], 0);
    assert_eq!(
        other.call("POST", &accept, None).await.0,
        StatusCode::NOT_FOUND
    );
    let (status, accepted) = admin.call("POST", &accept, None).await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["status"], "ACCEPTED");
    for key in [
        "control_id",
        "evidence_target_type",
        "evidence_target_id",
        "valid_from",
        "hash_sha256",
        "created_at",
        "created_by",
    ] {
        assert_eq!(accepted[key], proposed[key], "{key}");
    }
    let (status, replay) = admin.retry("POST", &accept, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{replay}");
    assert_eq!(replay["error"]["code"], "command_applied");
    assert_eq!(
        admin.call("POST", &accept, None).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        http::audits(&pool, org, "compliance.evidence_binding.accept").await,
        1
    );
    let (status, page) = admin
        .call(
            "GET",
            &format!("{path}?status=ACCEPTED&target_type=external_document"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["id"], proposed["id"]);
}
