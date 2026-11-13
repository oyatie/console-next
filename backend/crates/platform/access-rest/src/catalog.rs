//! GET /api/v1/access/catalog — the platform-fixed catalog, for option-first
//! role editors and grant sheets. Any signed-in account may read it.

use axum::Json;
use axum::extract::Extension;
use console_platform_authz::Principal;
use console_platform_authz::access::{Domain, Level, NodeKind, action_group, tagged};
use serde_json::{Value, json};

pub(crate) async fn get_catalog(Extension(_principal): Extension<Principal>) -> Json<Value> {
    Json(catalog())
}

pub(crate) fn catalog() -> Value {
    let domains: Vec<Value> =
        Domain::ALL
            .into_iter()
            .map(|domain| {
                let mut operations: Vec<Value> = tagged()
                    .filter(|(_, d, _)| *d == domain)
                    .map(|(f, _, level)| json!({ "operation": f.as_str(), "level": level }))
                    .collect();
                // Record-level Cedar clearance is an action group, not a legacy Feature.
                operations.extend(domain.record_levels().iter().map(
                    |level| json!({ "operation": action_group(domain, *level), "level": level }),
                ));
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
    fn payroll_and_sensitive_pay_group_clearance_are_offered_without_unused_levels() {
        let c = super::catalog();
        for (domain, operations) in [
            (
                "pay",
                serde_json::json!([
                    {"operation":"payroll_run_read","level":"view"},
                    {"operation":"payroll_run_manage","level":"edit"}
                ]),
            ),
            (
                "sensitive",
                serde_json::json!([
                    {"operation":"sensitive::view","level":"view"},
                    {"operation":"sensitive::edit","level":"edit"},
                    {"operation":"sensitive::export","level":"export"}
                ]),
            ),
        ] {
            let row = c["domains"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["domain"] == domain)
                .unwrap();
            assert_eq!(row["grantable"], true);
            assert_eq!(row["operations"], operations);
        }
    }

    #[test]
    fn a_todo_request_line_offers_only_asking() {
        let c = super::catalog();
        let row = c["domains"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["domain"] == "todo_request")
            .unwrap();
        assert_eq!(row["grantable"], true);
        assert_eq!(row["levels"], serde_json::json!(["edit"]));
        assert_eq!(
            row["operations"],
            serde_json::json!([{"operation":"todo_assign","level":"edit"}])
        );
    }

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
