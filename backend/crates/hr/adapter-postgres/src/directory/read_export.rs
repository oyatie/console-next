//! `GET /employees/export.csv`: the list's filtered rows as the standard CSV
//! (UTF-8 BOM for Excel, formula neutralisation), with its download 용도
//! logged before the first byte (INF-02, GOV-PEO-1; 고시 2023-6 §8②), then
//! streamed with no row cap (PEOPLE-B).

use console_kernel_core::BranchScope;
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use futures::channel::mpsc;
use futures::{SinkExt, TryStreamExt};
use http::StatusCode;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::authz::{HrReach, Tier, hr_reach_in};
use crate::clock::today_kst;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::directory::read_export_register::ExportLayout;
use crate::directory::read_filters::{
    EmployeeListFilters, EmployeeListQuery, counted_employees, filtered_employees,
};
use crate::{HrError, HrService};

pub const EMPLOYEE_EXPORT_FILE_NAME: &str = "employees-standard.csv";

/// The download 용도 codes (governance design S6).
// a fixed list until GOV-RC-1 ships the `export_purpose` reason
// domain; then validate against that domain instead.
pub const EXPORT_PURPOSES: &[&str] = &[
    "AUDIT_RESPONSE",
    "INTERNAL_REVIEW",
    "DISPUTE_RESPONSE",
    "DATA_SUBJECT_REQUEST",
    "OTHER",
];

pub(crate) const CSV_HEADER: &str = "company,name,employee_number,org_unit,worksite_name,job,position,hire_date,exit_date,status,leave_remaining\r\n";
const CSV_COLUMNS: [&str; 11] = [
    "company",
    "name",
    "employee_number",
    "org_unit",
    "worksite_name",
    "job",
    "position",
    "hire_date",
    "exit_date",
    "employment_status",
    "leave_remaining",
];
pub(crate) const EXPORT_SELECT: &str = "SELECT e.company, e.name, e.employee_number, e.org_unit, \
    e.worksite_name, e.job, e.position, to_char(e.hire_on, 'YYYY-MM-DD') AS hire_date, to_char(e.exit_on, 'YYYY-MM-DD') AS exit_date, entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AS employment_status, \
    e.leave_remaining::TEXT AS leave_remaining";
/// Rows are sent in chunks of about this many bytes.
const CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub struct ExportPurposeQuery {
    pub export_purpose: Option<String>,
    /// `standard` (default) or `register` (근로자 명부 columns).
    pub layout: Option<String>,
}

/// The CSV body, in order; an `Err` ends the download early.
pub type CsvChunks = mpsc::Receiver<Result<String, HrError>>;

/// 422 `export_purpose_required`: no 용도, or one outside [`EXPORT_PURPOSES`].
pub fn export_purpose_required() -> HrError {
    HrError {
        errors: None,
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "export_purpose_required",
        message: "export_purpose is required: AUDIT_RESPONSE, INTERNAL_REVIEW, \
                  DISPUTE_RESPONSE, DATA_SUBJECT_REQUEST or OTHER"
            .to_owned(),
        refusals: None,
    }
}

pub fn optional_row_text(row: &sqlx::postgres::PgRow, key: &str) -> Result<String, HrError> {
    Ok(row.try_get::<Option<String>, _>(key)?.unwrap_or_default())
}

pub fn csv_field(value: &str) -> String {
    let safe = neutralize_spreadsheet_formula(value);
    if safe.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", safe.replace('"', "\"\""))
    } else {
        safe
    }
}

pub fn neutralize_spreadsheet_formula(value: &str) -> String {
    if matches!(value.chars().next(), Some('=' | '+' | '-' | '@')) {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

/// `excel_export_logs.scope_key` as the reporting exports write it.
/// The export log's scope column: `ALL`, or the reach's nodes and branches.
fn scope_key(reach: &HrReach) -> String {
    let HrReach::Within { scope, branches } = reach else {
        return "ALL".to_owned();
    };
    let mut parts = Vec::new();
    let tagged = |tag: &str, ids: &[uuid::Uuid]| {
        ids.iter()
            .map(|id| format!("{tag}:{id}"))
            .collect::<Vec<_>>()
    };
    parts.extend(tagged("LE", &scope.entities));
    parts.extend(tagged("WP", &scope.workplaces));
    parts.extend(tagged("DEPT", &scope.units));
    if let Some(BranchScope::Branches(set)) = branches {
        parts.extend(set.iter().map(ToString::to_string));
    }
    parts.join(",")
}

pub(crate) fn push_csv_row(csv: &mut String, row: &sqlx::postgres::PgRow) -> Result<(), HrError> {
    for (index, column) in CSV_COLUMNS.iter().enumerate() {
        if index > 0 {
            csv.push(',');
        }
        csv.push_str(&csv_field(&optional_row_text(row, column)?));
    }
    csv.push_str("\r\n");
    Ok(())
}

impl HrService {
    /// Validates the 용도, commits the `excel_export_logs` row and its
    /// 접속기록 event, then streams the CSV from a second read transaction.
    /// A missing or unknown 용도 is refused, and the refusal is logged too.
    pub async fn export_employees_csv(
        &self,
        principal: Principal,
        query: EmployeeListQuery,
        purpose: ExportPurposeQuery,
    ) -> Result<(&'static str, CsvChunks), HrError> {
        // AX-5: the rows are where the reader holds 내보내기 (the 인사기본
        // export level carries its view, so that reach is readable too).
        hr_reach_in(&principal, Feature::EmployeeDirectoryRead, Tier::Branch)?;
        let reach = hr_reach_in(&principal, Feature::ExcelDownload, Tier::Branch)?;
        let filters =
            EmployeeListFilters::from_query(&query, &principal.branch_scope)?.with_reach(reach);
        let layout = ExportLayout::parse(purpose.layout.as_deref())?;
        // The register carries 생년월일 and the personal phone, which a
        // read-only reader never sees (`redact_for_reader`): HR (manage) only.
        if layout == ExportLayout::Register {
            hr_reach_in(&principal, Feature::EmployeeDirectoryManage, Tier::Branch)?;
        }
        let org = principal.org_id;
        let given = purpose.export_purpose.as_deref().map(str::trim);
        let Some(purpose) = given.and_then(|given| EXPORT_PURPOSES.iter().find(|p| **p == given))
        else {
            let refused = access_event(
                &principal,
                DirectoryAccess::DownloadRefused,
                &[],
                None,
                json!({ "code": "export_purpose_required", "export_purpose_given": given.is_some() }),
            )?;
            with_audits::<_, _, HrError>(&self.pool, org, move |_tx| {
                Box::pin(async move { Ok(((), vec![refused])) })
            })
            .await?;
            return Err(export_purpose_required());
        };

        let logged = filters.clone();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows: i64 = counted_employees("SELECT count(*)", &logged)
                    .build_query_scalar()
                    .fetch_one(tx.as_mut())
                    .await?;
                let log_id = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO excel_export_logs (id, org_id, actor, scope_key, export_kind, \
                     export_date, file_name, source_notes, export_purpose) \
                     VALUES ($1, $2, $3, $8, 'employee_directory', $4, $5, $6, $7)",
                )
                .bind(log_id)
                .bind(*principal.org_id.as_uuid())
                .bind(*principal.user_id.as_uuid())
                .bind(today_kst())
                .bind(layout.file_name())
                .bind(json!([{ "row_count": rows }]))
                .bind(*purpose)
                .bind(scope_key(&logged.reach))
                .execute(tx.as_mut())
                .await?;
                let me = actor_employee_id(tx, &principal).await?;
                // a download names its row count, not every subject
                // id (unbounded); GOV S7 shows downloads by 용도 and count.
                let event = access_event(
                    &principal,
                    DirectoryAccess::Download,
                    &[],
                    me,
                    json!({ "export_purpose": purpose, "row_count": rows, "export_log_id": log_id }),
                )?;
                Ok(((), vec![event]))
            })
        })
        .await?;

        let (sender, receiver) = mpsc::channel(4);
        let pool = self.pool.clone();
        tokio::spawn(async move {
            let mut failed = sender.clone();
            let streamed = with_org_conn::<_, _, HrError>(&pool, org, move |tx| {
                Box::pin(async move { stream_rows(tx, &filters, layout, sender).await })
            })
            .await;
            if let Err(error) = streamed {
                let _ = failed.send(Err(error)).await;
            }
        });
        Ok((layout.file_name(), receiver))
    }
}

/// Sends the BOM and header, then the rows in [`CHUNK_BYTES`] chunks. Stops
/// quietly when the client has gone (the receiver was dropped).
async fn stream_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    filters: &EmployeeListFilters,
    layout: ExportLayout,
    mut sender: mpsc::Sender<Result<String, HrError>>,
) -> Result<(), HrError> {
    let mut chunk = format!("\u{feff}{}", layout.header());
    let mut query = filtered_employees(layout.select(), filters);
    query.push(" ORDER BY e.company ASC, e.name ASC, e.source_sheet ASC, e.source_row ASC");
    let mut rows = query.build().fetch(tx.as_mut());
    while let Some(row) = rows.try_next().await? {
        layout.push_row(&mut chunk, &row)?;
        if chunk.len() >= CHUNK_BYTES && sender.send(Ok(std::mem::take(&mut chunk))).await.is_err()
        {
            return Ok(());
        }
    }
    let _ = sender.send(Ok(chunk)).await;
    Ok(())
}
