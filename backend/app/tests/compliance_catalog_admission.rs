// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

fn has(body: &Value, capability: &str) -> bool {
    body["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["feature"] == capability)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recorded_catalog_follows_scope_and_effective_enrollment(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (other, _) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let caller = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (_, _, branch, _) = http::structure(&caller).await;
    let own_path = format!("/api/v1/location-consent/status?branch_id={branch}");
    let frameworks = "/api/v1/compliance/frameworks";
    let authz = "/api/v1/me/authz";
    let path = "/api/v1/compliance/evidence-bindings";
    let body = json!({"name":"Synthetic framework","version_label":"v1","framework_kind":"INTERNAL_CONTROL","effective_from":"2026-03-01"});
    sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,'compliance',true,'other tenant')")
        .bind(other).execute(&pool).await.unwrap();
    let (status, caps) = caller.call("GET", authz, None).await;
    assert_eq!(status, StatusCode::OK, "{caps}");
    assert!(!has(&caps, "served_compliance_catalog"));
    let (privacy_status, privacy) = caller
        .call("GET", "/api/v1/privacy/rights-requests/mine", None)
        .await;
    assert_eq!(privacy_status, StatusCode::OK, "{privacy}");
    if !cfg!(feature = "compliance") {
        assert_eq!(
            caller.call("GET", frameworks, None).await.0,
            StatusCode::NOT_FOUND
        );
        return;
    }
    for p in [frameworks, path] {
        let (status, denied) = caller.call("GET", p, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
        assert_eq!(denied["error"]["code"], "module_disabled");
    }
    let (own_status, own) = caller.call("GET", &own_path, None).await;
    assert_eq!(own_status, StatusCode::OK, "{own}");
    assert_eq!(
        caller
            .call(
                "GET",
                "/api/v1/statutory/insurance-loss-codes?insurer=EI&on=2026-03-01",
                None
            )
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,'compliance',true,'catalog launch')")
        .bind(org).execute(&pool).await.unwrap();
    let (_, caps) = caller.call("GET", authz, None).await;
    assert!(
        has(&caps, "served_compliance_catalog") && has(&caps, "served_compliance_catalog_manage"),
        "{caps}"
    );
    let (status, saved) = caller.call("POST", frameworks, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["effective_from"], "2026-03-01");
    assert!(saved["created_at"].as_str().is_some());
    assert_eq!(saved["metadata"], json!({}));
    let key = caller.key.get();
    let (_, items) = caller.call("GET", frameworks, None).await;
    assert_eq!(items["total"], 1, "{items}");
    assert_eq!(items["items"][0]["id"], saved["id"]);
    let (_, past_end) = caller
        .call("GET", "/api/v1/compliance/frameworks?offset=1", None)
        .await;
    assert_eq!(
        (
            past_end["total"].as_i64(),
            past_end["items"].as_array().unwrap().len()
        ),
        (Some(1), 0)
    );
    let (replayed, already) = caller
        .send("POST", frameworks, Some(body.clone()), Some(key))
        .await;
    assert_eq!(replayed, StatusCode::CONFLICT, "{already}");
    assert_eq!(already["error"]["code"], "command_applied");
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES ($1,'module.compliance.enabled','false',clock_timestamp(),$2,'operator_option')")
        .bind(org).bind(user.as_uuid()).execute(&pool).await.unwrap();
    let (refused, disabled) = caller.send("POST", frameworks, Some(body), Some(key)).await;
    assert_eq!(refused, StatusCode::FORBIDDEN, "{disabled}");
    assert_eq!(disabled["error"]["code"], "module_disabled");
    assert!(!has(
        &caller.call("GET", authz, None).await.1,
        "served_compliance_catalog"
    ));
    assert_eq!(caller.call("GET", &own_path, None).await.0, StatusCode::OK);
}

#[cfg(feature = "compliance")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn operator_can_create_and_join_catalog_records_through_the_declared_commands(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let caller = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,'compliance',true,'catalog commands')").bind(org).execute(&pool).await.unwrap();
    let create = async |kind: &str, body: Value| -> Value {
        let (s, v) = caller
            .call("POST", &format!("/api/v1/compliance/{kind}"), Some(body))
            .await;
        assert_eq!(s, StatusCode::OK, "{kind} {v}");
        assert!(v["created_at"].as_str().is_some(), "{kind} {v}");
        v
    };
    let fw = create(
        "frameworks",
        json!({"name":"Synthetic review","version_label":"v1","framework_kind":"INTERNAL_CONTROL"}),
    )
    .await;
    let reg = create("regulations",json!({"title":"Synthetic rule","jurisdiction":"Demo","citation":"Synthetic §1","impact_area":"Training","impact_summary":"Review training","risk_level":"LOW","effective_from":"2026-05-01"})).await;
    let ob = create("obligations",json!({"title":"Review training","description":"Annual synthetic review","obligation_type":"INTERNAL_POLICY","severity":"LOW","scope":{"kind":"ORG"},"effective_from":"2026-05-01"})).await;
    let ctrl = create("framework-controls",json!({"framework_id":fw["id"],"control_key":"TRAINING_REVIEW","title":"Review log","objective":"Maintain training log","control_type":"PREVENTIVE"})).await;
    assert_eq!(ctrl["evidence_requirements"], json!([]));
    let link = create("obligation-regulation-links",json!({"obligation_id":ob["id"],"regulation_impact_id":reg["id"],"relationship":"DERIVED_FROM"})).await;
    assert_eq!(link["obligation_id"], ob["id"]);
    let coverage = create(
        "control-obligation-coverage",
        json!({"control_id":ctrl["id"],"obligation_id":ob["id"],"coverage_level":"PRIMARY"}),
    )
    .await;
    assert_eq!(coverage["control_id"], ctrl["id"]);
    for kind in [
        "obligations".to_owned(),
        "regulations".to_owned(),
        format!(
            "framework-controls?framework_id={}",
            fw["id"].as_str().unwrap()
        ),
    ] {
        let (s, page) = caller
            .call("GET", &format!("/api/v1/compliance/{kind}"), None)
            .await;
        assert_eq!(s, StatusCode::OK, "{page}");
        assert_eq!(page["total"], 1);
    }
}

#[cfg(feature = "compliance")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn control_requirement_spellings_round_trip_one_ordered_array(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let caller = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,'compliance',true,'requirements compatibility')").bind(org).execute(&pool).await.unwrap();
    let (status, framework) = caller
        .call(
            "POST",
            "/api/v1/compliance/frameworks",
            Some(json!({
                "name":"Compatibility", "version_label":"v1", "framework_kind":"INTERNAL_CONTROL"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{framework}");
    let path = "/api/v1/compliance/framework-controls";
    let framework_id = framework["id"].as_str().unwrap();
    let post = async |key: &str, fields: Value| {
        let mut body = json!({"framework_id": framework_id, "control_key": key, "title": key, "objective":"Review", "control_type":"PREVENTIVE"});
        body.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        caller.call("POST", path, Some(body)).await
    };
    let items = json!(["report", {"kinds":["ledger", "receipt"]}, null, 2]);
    for (key, fields, expected) in [
        ("OMITTED", json!({}), json!([])),
        (
            "LEGACY",
            json!({"evidence_requirements":items}),
            items.clone(),
        ),
        (
            "TYPED",
            json!({"evidence_requirement_items":items}),
            items.clone(),
        ),
        (
            "MATCHING",
            json!({"evidence_requirement_items":items, "evidence_requirements":items}),
            items.clone(),
        ),
    ] {
        let (status, saved) = post(key, fields).await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        assert_eq!(saved["evidence_requirements"], expected);
        assert_eq!(saved["evidence_requirement_items"], expected);
    }
    for fields in [
        json!({"evidence_requirements":{}}),
        json!({"evidence_requirement_items":{}}),
        json!({"evidence_requirements":null}),
        json!({"evidence_requirement_items":null}),
        json!({"evidence_requirements":null,"evidence_requirement_items":[]}),
        json!({"evidence_requirements":[],"evidence_requirement_items":null}),
        json!({"evidence_requirements":items,"evidence_requirement_items":[]}),
    ] {
        let (status, error) = post("REFUSED", fields).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    }
    let (status, page) = caller
        .call("GET", &format!("{path}?framework_id={framework_id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 4);
    for row in page["items"].as_array().unwrap() {
        let expected = if row["control_key"] == "OMITTED" {
            json!([])
        } else {
            items.clone()
        };
        assert_eq!(row["evidence_requirements"], expected);
        assert_eq!(row["evidence_requirement_items"], expected);
    }
}
