//! GET /api/v1/access/catalog — the platform-fixed catalog, for option-first
//! role editors and grant sheets. Any signed-in account may read it.

use axum::Json;
use axum::extract::Extension;
use console_platform_authz::Principal;
use console_platform_authz::access::{Domain, Level, NodeKind, tagged};
use serde_json::{Value, json};

pub(crate) async fn get_catalog(Extension(_principal): Extension<Principal>) -> Json<Value> {
    Json(catalog())
}

pub(crate) fn catalog() -> Value {
    let domains: Vec<Value> = Domain::ALL
        .into_iter()
        .map(|domain| {
            let operations: Vec<Value> = tagged()
                .filter(|(_, d, _)| *d == domain)
                .map(|(f, _, level)| json!({ "operation": f.as_str(), "level": level }))
                .collect();
            json!({
                "domain": domain,
                "grantable": domain.grantable(),
                "levels": domain.offered(),
                "operations": operations,
            })
        })
        .collect();
    let scope_kinds: Vec<Value> = [
        NodeKind::Tenant,
        NodeKind::LegalEntity,
        NodeKind::Workplace,
        NodeKind::Department,
    ]
    .into_iter()
    .map(|kind| {
        json!({
            "kind": kind,
            "enforceable": kind.enforceable_in_pilot(),
            "descendants_only": true,
        })
    })
    .collect();
    json!({
        "domains": domains,
        "levels": Level::ALL,
        "scope_kinds": scope_kinds,
        "reason_domain": "role_change",
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_catalog_lists_every_domain_and_marks_every_scope_kind_enforceable() {
        let c = super::catalog();
        assert_eq!(
            c["domains"].as_array().unwrap().len(),
            super::Domain::ALL.len()
        );
        let support = c["domains"]
            .as_array()
            .unwrap()
            .iter()
            .find(|domain| domain["domain"] == super::Domain::SupportAccess.as_str())
            .unwrap();
        assert_eq!(support["grantable"], true);
        assert_eq!(
            support["levels"],
            serde_json::json!([super::Level::Approve])
        );
        let hr = &c["domains"][1];
        assert_eq!(hr["domain"], "hr_basic");
        assert_eq!(
            hr["levels"],
            serde_json::json!(["view", "edit", "approve", "export"])
        );
        assert!(
            hr["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|o| o["operation"] == "employee_directory_manage" && o["level"] == "edit")
        );
        let dept = &c["scope_kinds"][3];
        assert_eq!(dept["kind"], "DEPARTMENT");
        assert_eq!(
            dept["enforceable"], true,
            "AX-5: a 부서 subtree is enforced"
        );
        assert_eq!(c["domains"][8]["grantable"], false, "discipline");
    }
}
