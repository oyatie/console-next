// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! HTTP integration verification for `PUT /api/v1/employees/import/{run_id}/cells`:
//! `EmployeeDirectoryManage` gating, cross-tenant isolation, restricted-column & 2-digit-year
//! rejection, audit logging, and persisted cell repairs consumed by dry run.

use axum::{
    Extension, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::import::types::ImportDryRunRequest;
use console_hr_domain::import::plan::Decisions;
use console_hr_rest::import_runs::router;
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use tower::ServiceExt;
use uuid::Uuid;

fn app(hr: HrService, principal: Principal) -> Router {
    router(hr, None).layer(Extension(principal))
}

async fn put_cells(app: Router, run_id: Uuid, body: Value) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/v1/employees/import/{run_id}/cells"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn import_cells_repair_enforces_authz_tenant_restricted_columns_two_digit_year_and_persists(
    pool: PgPool,
) {
    let org_a = OrgId::from_uuid(Uuid::new_v4());
    let org_b = OrgId::from_uuid(Uuid::new_v4());
    let super_a = seed_org_and_super_admin(&pool, *org_a.as_uuid(), "cells-a").await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(super_a.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let super_b = seed_org_and_super_admin(&pool, *org_b.as_uuid(), "cells-b").await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(super_b.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let member_a = seed_active_user(&pool, *org_a.as_uuid(), "MEMBER", "cells-mem").await;

    let run_id = Uuid::new_v4();
    let source_key = "filename:repair.xlsx|sheet:Sheet1|row:2";
    sqlx::query(
        "INSERT INTO data_import_runs (org_id, id, entity_type, source_filename, source_format, source_sha256, mapping_profile, status, input_rows, candidate_rows, preserved_rows, created_by) \
         VALUES ($1, $2, 'employee_hr', 'repair.xlsx', 'xlsx', repeat('a', 64), '{\"confirmed\":true,\"columns\":[]}'::jsonb, 'PREVIEWED', 1, 1, 0, $3)",
    )
    .bind(org_a.as_uuid())
    .bind(run_id)
    .bind(super_a.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO data_import_rows (org_id, run_id, source_sheet, source_row, source_key, row_status, raw_row, canonical_row, validation) \
         VALUES ($1, $2, 'Sheet1', 2, $3, 'CANDIDATE', '{}', $4, '{}')",
    )
    .bind(org_a.as_uuid())
    .bind(run_id)
    .bind(source_key)
    .bind(json!({
        "company": "Acme",
        "name": "Kim Prehire",
        "source_filename": "repair.xlsx",
        "source_sheet": "Sheet1",
        "source_row": 2,
        "source_key": source_key,
        "source_metadata": {
            "cells": {
                "employee_number": "A2",
                "name": "B2",
                "hire_date": "C2",
                "birth_date": "D2",
                "id_type": "E2"
            }
        },
        "canonical": {
            "employee_number": "PRE-1",
            "hire_date": "2029-05-01",
            "birth_date": "95-03-04",
            "id_type": "NOT_ISSUED"
        }
    }))
    .execute(&pool)
    .await
    .unwrap();

    let hr = HrService::new(runtime_role_pool(&pool).await);
    let p_a = Principal::new(
        super_a,
        org_a,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let p_b = Principal::new(
        super_b,
        org_b,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let p_mem = Principal::new(
        member_a,
        org_a,
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    );

    // 1. Member without EmployeeDirectoryManage receives 403
    let (s_mem, _) = put_cells(
        app(hr.clone(), p_mem),
        run_id,
        json!({ "cells": { (source_key): { "birth_date": "1995-03-04" } } }),
    )
    .await;
    assert_eq!(s_mem, StatusCode::FORBIDDEN);

    // 2. Cross-tenant admin receives 404
    let (s_b, _) = put_cells(
        app(hr.clone(), p_b),
        run_id,
        json!({ "cells": { (source_key): { "birth_date": "1995-03-04" } } }),
    )
    .await;
    assert_eq!(s_b, StatusCode::NOT_FOUND);

    // 3. Restricted targets (including case variants and header aliases) rejected fail-closed with 422
    let mut restricted_fields: Vec<String> = vec![
        "rrn".into(),
        "phone".into(),
        "name".into(),
        "RRN".into(),
        "Phone".into(),
        "NAME".into(),
        "Mobile".into(),
        "Employee Name".into(),
    ];
    for target in ["rrn", "phone", "name"] {
        if let Some(def) =
            console_hr_domain::import::classification::employee_import_field_for_target(target)
            && let Some(alias) = def.aliases.first()
        {
            restricted_fields.push((*alias).to_string());
        }
    }
    for field in restricted_fields {
        let (s_res, b_res) = put_cells(
            app(hr.clone(), p_a.clone()),
            run_id,
            json!({ "cells": { (source_key): { (&field): "X" } } }),
        )
        .await;
        assert_eq!(s_res, StatusCode::UNPROCESSABLE_ENTITY, "{field}: {b_res}");
        assert_eq!(
            b_res["error"]["code"], "mapping_restricted_column",
            "{field}: {b_res}"
        );
    }

    // 4. Two-digit year repair values (birth_date and probation_end_date) rejected with 422 two_digit_year
    for (field, val) in [
        ("birth_date", "95-03-04"),
        ("probation_end_date", "26-06-01"),
    ] {
        let (s_2y, b_2y) = put_cells(
            app(hr.clone(), p_a.clone()),
            run_id,
            json!({ "cells": { (source_key): { (field): val } } }),
        )
        .await;
        assert_eq!(s_2y, StatusCode::UNPROCESSABLE_ENTITY, "{field}: {b_2y}");
        assert_eq!(b_2y["error"]["code"], "two_digit_year", "{field}: {b_2y}");
    }

    // 5. Valid repair persists dry_run_decisions.cells, emits audit, and resolves dry run
    let (s_ok, b_ok) = put_cells(
        app(hr.clone(), p_a.clone()),
        run_id,
        json!({ "cells": { (source_key): { "birth_date": "1995-03-04" } } }),
    )
    .await;
    assert_eq!(s_ok, StatusCode::OK, "{b_ok}");
    assert_eq!(b_ok["repaired_rows"], 1);
    assert_eq!(b_ok["cells"][source_key]["birth_date"], "1995-03-04");

    let summary = hr
        .dry_run_import(
            p_a,
            run_id,
            ImportDryRunRequest {
                decisions: Decisions::default(),
            },
        )
        .await
        .unwrap();
    assert_eq!(summary.review.blocking, 0, "{:?}", summary.review.items);
    assert_eq!(
        summary.rows[0]
            .new_person
            .as_ref()
            .and_then(|p| p.birth_date.as_deref()),
        Some("1995-03-04")
    );

    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'data_import.cells_repair' AND target_id = $2",
    )
    .bind(org_a.as_uuid())
    .bind(run_id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count, 1);
}
