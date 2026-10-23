// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::{Json, Router, routing::get};
use serde_json::json;

pub fn probes() -> Router {
    Router::new()
        .route("/api/v1/org-units", get(|| async { Json(json!({"items":[{"id":"unit","kind":"DEPARTMENT","name":"인사부","parentId":"root","status":"ACTIVE","effectiveFrom":"2026-10-23","updatedAt":"2026-10-23T00:00:00Z","headcount":5,"head":{"name":"담당자"}}]})) }))
        .route("/api/v1/org-structure", get(|| async { Json(json!({"as_of":"2026-10-23","tenant_name":"고객사","phase":"OPERATING","entities":[{"name":"법인","children":[{"name":"부서","head":{"name":"담당자","employee_id":"person"}}]}]})) }))
        .route("/api/v1/legal-entities", get(|| async { Json(json!({"items":[{"id":"entity","founding":false,"current":{"name":"고객 법인","representatives":["대표자"]}}]})) }))
        .route("/api/v1/workplaces", get(|| async { Json(json!({"items":[{"id":"workplace","kind_code":"OFFICE","headcount":5,"current":{"name":"서울 사업장","representative_name":"대표자","email":"private@example.com","mobile":{"value":"010-private","display":"010-private"}}}]})) }))
}
