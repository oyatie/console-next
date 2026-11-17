// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::{BTreeMap, BTreeSet};

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::import::sheet::SheetContext;
use console_hr_adapter_postgres::import::types::{ImportDryRunRequest, XlsxUpload};
use console_hr_adapter_postgres::import::workbook::parse_workbook;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

pub(super) type Out<T> = Result<T, String>;

pub(super) fn e<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

pub(super) fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

/// A roster staged and dry-run through the service: `(run, digest)`.
pub(super) async fn planned(pool: &PgPool, org: Uuid, ops: UserId) -> Out<(Uuid, String)> {
    let rt = HrService::new(pool.clone());
    let principal = Principal::new(
        ops,
        OrgId::from_uuid(org),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let text = |t: &str| Cell::Text(t.into());
    let sheet = GridSheet {
        name: "명부".into(),
        rows: vec![
            GridRow {
                index: 0,
                cells: vec![
                    (0, text("성명")),
                    (1, text("입사일")),
                    (2, text("고용형태")),
                ],
            },
            GridRow {
                index: 1,
                cells: vec![
                    (0, text("김일")),
                    (1, text("2024-03-04")),
                    (2, text("정규직")),
                ],
            },
        ],
    };
    let ctx = SheetContext {
        filename: "a.xlsx",
        org,
        vault: None,
    };
    let parsed = parse_workbook(
        &ctx,
        &[sheet],
        &BTreeMap::new(),
        &serde_json::from_value::<WorkbookMappingRequest>(serde_json::json!({"sheets": {"명부": {"header_row": 1, "columns": {"A": "name", "B": "hire_date", "C": "employment_type"}}}})).unwrap(),
    )
    .map_err(|x| x.message)?;
    let upload = XlsxUpload {
        filename: "a.xlsx".into(),
        bytes: Vec::new(),
        mapping: None,
        pay_period_start: None,
        pay_period_end: None,
    };
    let run = rt
        .preview_import(principal.clone(), upload, "c".repeat(64), parsed)
        .await
        .map_err(|x| x.message)?
        .run_id;
    let plan = rt
        .dry_run_import(principal, run, ImportDryRunRequest::default())
        .await
        .map_err(|x| x.message)?;
    Ok((run, plan.dry_run_digest))
}
