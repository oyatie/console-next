//! The label routes of the first run (decisions #18; review R15, R16): the
//! 사업장 kind list and a 사업장's kind, its code, and 부서 order.

use http::StatusCode;
use serde_json::{Value, json};

use super::Ctx;

/// MR-19 over HTTP: the kind list (platform defaults, then the tenant's), a
/// tenant kind, a relabelled default, and the 사업장's kind set directly.
pub(super) async fn workplace_kind_routes(ctx: &Ctx, workplace: &str) {
    let (status, list) = ctx.call("GET", "/api/v1/workplace-kinds", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["items"].as_array().unwrap().len(), 8, "{list}");
    let (status, depot) = ctx
        .call(
            "POST",
            "/api/v1/workplace-kinds",
            Some(json!({ "label": "창고" })),
        )
        .await;
    assert_eq!(
        (status, depot["platform"].as_bool()),
        (StatusCode::CREATED, Some(false)),
        "{depot}"
    );
    let (status, taken) = ctx
        .call(
            "POST",
            "/api/v1/workplace-kinds",
            Some(json!({ "label": "창고" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{taken}");
    let (status, relabelled) = ctx
        .call(
            "PATCH",
            "/api/v1/workplace-kinds/STORE",
            Some(json!({ "label": "점포" })),
        )
        .await;
    assert_eq!(
        (status, relabelled["label"].as_str()),
        (StatusCode::OK, Some("점포")),
        "{relabelled}"
    );
    let uri = format!("/api/v1/workplaces/{workplace}/kind");
    let (status, set) = ctx
        .call("PUT", &uri, Some(json!({ "kind_code": depot["code"] })))
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(set["record"]["kind_code"], depot["code"], "{set}");
    let (status, bad) = ctx
        .call("PUT", &uri, Some(json!({ "kind_code": "factory" })))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    let (_, tree) = ctx.call("GET", "/api/v1/org-structure", None).await;
    assert_eq!(
        tree["entities"][0]["children"][0]["workplace_kind"], depot["code"],
        "{tree}"
    );
}

/// 사업장 code and 부서 order through the router (review R15, R16), and the
/// chart's 사업장 직속 count (spec D2).
pub(super) async fn structure_label_routes(ctx: &Ctx, workplace: &str) {
    let uri = format!("/api/v1/workplaces/{workplace}/code");
    let (status, set) = ctx
        .call("PUT", &uri, Some(json!({ "code": "HQ-01" })))
        .await;
    assert_eq!(
        (status, set["record"]["code"].as_str()),
        (StatusCode::OK, Some("HQ-01")),
        "{set}"
    );
    let (status, bad) = ctx.call("PUT", &uri, Some(json!({ "code": "본사" }))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    let (_, tree) = ctx.call("GET", "/api/v1/org-structure", None).await;
    let wp = &tree["entities"][0]["children"][0];
    assert_eq!(
        (wp["code"].as_str(), wp["direct_headcount"].as_i64()),
        (Some("HQ-01"), Some(1)),
        "{tree}"
    );
    let mut order: Vec<Value> = wp["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].clone())
        .collect();
    order.reverse();
    let body = json!({ "workplace_id": workplace, "children": order });
    let (status, saved) = ctx
        .call("PUT", "/api/v1/org-structure/order", Some(body))
        .await;
    assert_eq!(
        (status, &saved["children"]),
        (StatusCode::OK, &json!(order)),
        "{saved}"
    );
    let stale = json!({ "workplace_id": workplace, "children": [] });
    let (status, refused) = ctx
        .call("PUT", "/api/v1/org-structure/order", Some(stale))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    // The tenant's 법인 (no parent named), pinned to the order read: a
    // stale pin is 409 and writes nothing (org-sibling-order).
    let entities: Vec<Value> = tree["entities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].clone())
        .collect();
    let pinned = json!({ "children": entities, "expected_children": entities });
    let (status, saved) = ctx
        .call("PUT", "/api/v1/org-structure/order", Some(pinned))
        .await;
    assert_eq!(
        (status, &saved["children"]),
        (StatusCode::OK, &json!(entities)),
        "{saved}"
    );
    let stale = json!({ "children": entities, "expected_children": [] });
    let (status, refused) = ctx
        .call("PUT", "/api/v1/org-structure/order", Some(stale))
        .await;
    assert_eq!(
        (status, refused["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("children_changed")),
        "{refused}"
    );
}
