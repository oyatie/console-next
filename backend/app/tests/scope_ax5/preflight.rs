// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant preflights preserve typed scope refusals through the HTTP principal.
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{code, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_preflights_name_the_tenant_boundary_before_disclosing_facts(pool: PgPool) {
    let mut w = world::world_with_lines(
        pool,
        json!([
            {"domain":"hr_basic","levels":["view","edit"]},
            {"domain":"appointment","levels":["edit"]}
        ]),
    )
    .await;
    for (kind, node) in [
        ("LEGAL_ENTITY", w.le_a.clone()),
        ("WORKPLACE", w.wp_a.clone()),
        ("DEPARTMENT", w.dept_x.clone()),
    ] {
        let caller = w.holder(kind, Some(&node)).await;
        for employee in [&w.a1, &Uuid::new_v4().to_string()] {
            for path in [
                format!("/api/v1/employees/{employee}/fixed-term"),
                format!("/api/v1/employees/{employee}/fixed-term?contract_end_date=invalid"),
            ] {
                let (status, body) = caller.call("GET", &path, None).await;
                assert_eq!(
                    (status, code(&body)),
                    (StatusCode::FORBIDDEN, "scope_tenant_wide_only"),
                    "{body}"
                );
                assert!(
                    body["error"]["refusals"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|n| n["kind"] == kind && n["node_id"] == node),
                    "{body}"
                );
            }
        }
        for path in [
            "/api/v1/employees/lifecycle-events/bulk/preview",
            "/api/v1/employees/lifecycle-events/bulk",
        ] {
            let (status, body) = caller.call("POST", path, Some(json!({"event_type":"PROMOTE","employee_ids":[w.a1],"effective_date":"2027-03-01","to_position":"과장","comment":"정기 인사"}))).await;
            assert_eq!(
                (status, code(&body)),
                (StatusCode::FORBIDDEN, "scope_tenant_wide_only"),
                "{body}"
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn appointment_only_holder_previews_and_commits_without_hr_basic(pool: PgPool) {
    let mut w = world::world_with_lines(
        pool,
        json!([
            {"domain":"appointment","levels":["edit"]}
        ]),
    )
    .await;
    let caller = w.holder("TENANT", None).await;
    let request = json!({"event_type":"PROMOTE","employee_ids":[w.a1],"effective_date":"2027-03-01","to_position":"과장","comment":"정기 인사"});
    let (status, preview) = caller
        .call(
            "POST",
            "/api/v1/employees/lifecycle-events/bulk/preview",
            Some(request.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let (status, committed) = caller
        .call(
            "POST",
            "/api/v1/employees/lifecycle-events/bulk",
            Some(request),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    assert_eq!(
        preview["counts"]["selected"],
        committed["items"].as_array().unwrap().len()
    );
    let (status, body) = caller
        .call(
            "GET",
            &format!(
                "/api/v1/employees/lifecycle-events/bulk/jobs/{}",
                Uuid::new_v4()
            ),
            None,
        )
        .await;
    assert_eq!((status, code(&body)), (StatusCode::NOT_FOUND, "not_found"));
}
