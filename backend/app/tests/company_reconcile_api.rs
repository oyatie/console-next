#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Applied company evidence stays tenant-scoped behind the existing import Cedar gate.
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::import::sheet::SheetContext;
use console_hr_adapter_postgres::import::types::XlsxUpload;
use console_hr_adapter_postgres::import::workbook::parse_workbook;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[path = "support/http.rs"]
mod support;
use support::{add_user, count, ctx, tenant};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn company_evidence_and_confirmation_refuse_other_tenants_and_lower_grants(pool: PgPool) {
    let (org, ops) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(&pool, org, ops, &["SUPER_ADMIN"], None).await;
    let user = add_user(&pool, org, &["ADMIN"]).await;
    let lower = ctx(&pool, org, user, &["ADMIN"], None).await;
    let (other_org, other_ops) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let other = ctx(&pool, other_org, other_ops, &["SUPER_ADMIN"], None).await;
    let fields = [
        ("회사", "GANATECH"),
        ("성명", "Employee"),
        ("사번", "E-1"),
        ("입사일", "2024-03-04"),
        ("고용형태", "정규직"),
    ];
    let grid = GridSheet {
        name: "roster".into(),
        rows: vec![
            GridRow {
                index: 0,
                cells: fields
                    .iter()
                    .zip(0_u32..)
                    .map(|((header, _), i)| (i, Cell::Text((*header).into())))
                    .collect(),
            },
            GridRow {
                index: 3,
                cells: fields
                    .iter()
                    .zip(0_u32..)
                    .map(|((_, value), i)| (i, Cell::Text((*value).into())))
                    .collect(),
            },
        ],
    };
    let parsed = parse_workbook(
        &SheetContext {
            filename: "company.xlsx",
            org,
            vault: None,
        },
        &[grid],
        &std::collections::BTreeMap::new(),
        &WorkbookMappingRequest::default(),
    )
    .unwrap();
    let principal = Principal::new(
        ops,
        OrgId::from_uuid(org),
        [Role::SuperAdmin].into_iter().collect(),
        BranchScope::All,
    );
    let run = HrService::new(pool.clone())
        .preview_import(
            principal,
            XlsxUpload {
                filename: "company.xlsx".into(),
                bytes: vec![],
                mapping: None,
                pay_period_start: None,
                pay_period_end: None,
            },
            "a".repeat(64),
            parsed,
        )
        .await
        .unwrap()
        .run_id;
    let (status, dry) = admin
        .call(
            "POST",
            &format!("/api/v1/employees/import/{run}/dry-run"),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{dry}");
    let (status, applied) = admin
        .call(
            "POST",
            &format!("/api/v1/employees/import/{run}/apply"),
            Some(json!({"dry_run_digest":dry["dry_run_digest"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    let rows = format!("/api/v1/employees/import/{run}/reconcile/rows");
    let (status, body) = admin.call("GET", &rows, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"][0]["company_confirmation"]["cell"], "A4");
    let key: String = url::form_urlencoded::byte_serialize(
        body["items"][0]["source_key"].as_str().unwrap().as_bytes(),
    )
    .collect();
    let row = format!("{rows}/{key}");
    for (caller, expected_status, expected_code) in [
        (&lower, StatusCode::FORBIDDEN, "forbidden"),
        (&other, StatusCode::NOT_FOUND, "not_found"),
    ] {
        for (method, path, body) in [
            ("GET", rows.as_str(), None),
            (
                "PUT",
                row.as_str(),
                Some(json!({"state":"CONFIRMED", "expected_version":0})),
            ),
        ] {
            let (status, body) = caller.call(method, path, body).await;
            assert_eq!(
                (status, body["error"]["code"].as_str().unwrap()),
                (expected_status, expected_code),
                "{body}"
            );
        }
    }
    let (status, body) = admin
        .call(
            "PUT",
            &row,
            Some(json!({"state":"CONFIRMED", "expected_version":0})),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str().unwrap()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "entity_certificate_unconfirmed"
        ),
        "{body}"
    );
    assert_eq!(count(&pool, "import_reconcile_checks", org).await, 0);
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'data_import.reconcile_check'")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(audits, 0);
}
