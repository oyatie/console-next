//! The IMPORT-2 harness: workbooks as typed grids staged through the real
//! any-layout parse, a test vault, and the BW-10 dry run / apply on the
//! runtime and leave-command pools.

use std::collections::BTreeMap;
use std::sync::Arc;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::import::sheet::SheetContext;
use console_hr_adapter_postgres::import::types::{
    EmployeeImportApplyRequest, EmployeeImportDryRunSummary, EmployeeImportPreviewResponse,
    EmployeeImportReport, ImportDryRunRequest, XlsxUpload,
};
use console_hr_adapter_postgres::import::workbook::parse_workbook;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use console_hr_domain::import::plan::Decisions;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use console_inbox_adapter_postgres::PgInboxStore;
use console_leave_adapter_postgres::PgLeaveStore;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::macros::date;
use uuid::Uuid;

use crate::fixture::{Fixture, fixture};

/// Test-only vault: the "ciphertext" is the digits reversed. Not cryptography;
/// the shell's vault (app `hr::rrn_vault`) is the real one.
pub struct MirrorVault;

impl RrnVault for MirrorVault {
    fn seal(&self, _org: Uuid, rrn: &Rrn) -> Result<SealedRrn, VaultError> {
        Ok(SealedRrn {
            hmac: self.blind_index(rrn),
            hmac_key_version: 1,
            ciphertext: rrn.digits().bytes().rev().chain([b'#'; 8]).collect(),
            nonce: vec![0; 24],
            dek_wrapped: vec![0; 16],
            dek_nonce: vec![0; 24],
            key_version: 1,
            masked: rrn.masked(),
        })
    }

    fn blind_index(&self, rrn: &Rrn) -> Vec<u8> {
        rrn.digits().bytes().cycle().take(32).collect()
    }

    fn open(&self, _org: Uuid, sealed: &SealedRrn) -> Result<Rrn, VaultError> {
        let digits: Vec<u8> = sealed.ciphertext.iter().take(13).rev().copied().collect();
        Rrn::parse(std::str::from_utf8(&digits).map_err(|_| VaultError)?).map_err(|_| VaultError)
    }
}

/// A sheet from `(row, column, text)` cells, 0-based; a text of digits only
/// becomes a number cell, as Excel stores it.
pub fn grid(name: &str, cells: &[(u32, u32, &str)]) -> GridSheet {
    let mut rows: Vec<GridRow> = Vec::new();
    for (row, col, text) in cells {
        let cell = match text.parse::<i64>() {
            Ok(n) if !text.starts_with('0') => Cell::Float(n as f64),
            _ => Cell::Text((*text).into()),
        };
        match rows.iter_mut().find(|r| r.index == *row) {
            Some(r) => r.cells.push((*col, cell)),
            None => rows.push(GridRow {
                index: *row,
                cells: vec![(*col, cell)],
            }),
        }
    }
    rows.sort_by_key(|r| r.index);
    GridSheet {
        name: name.into(),
        rows,
    }
}

/// A header row then data rows, left to right from column A.
pub fn table(name: &str, header_row: u32, rows: &[&[&str]]) -> GridSheet {
    let cells: Vec<(u32, u32, &str)> = rows
        .iter()
        .enumerate()
        .flat_map(|(r, cells)| {
            cells
                .iter()
                .enumerate()
                .filter(|(_, t)| !t.is_empty())
                .map(move |(c, t)| (header_row + r as u32, c as u32, *t))
        })
        .collect();
    grid(name, &cells)
}

pub struct Importer {
    pub f: Fixture,
    pub store: PgLeaveStore,
    pub owner: PgPool,
}

pub async fn importer(pool: PgPool) -> Importer {
    let options = pool.connect_options().as_ref().clone();
    let command = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_leave_cmd")
                    .execute(conn)
                    .await
                    .map(|_| ())
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    let f = fixture(pool.clone()).await;
    let store = PgLeaveStore::new(f.rt.clone(), Arc::new(PgInboxStore::new(f.rt.clone())))
        .with_leave_command_pool(command);
    Importer {
        f,
        store,
        owner: pool,
    }
}

impl Importer {
    pub fn org(&self) -> Uuid {
        *self.f.principal.org_id.as_uuid()
    }

    /// Parses `sheets` like the preview route and stages the run.
    pub async fn preview(
        &self,
        file: &str,
        sheets: &[GridSheet],
        mapping: &WorkbookMappingRequest,
    ) -> Result<EmployeeImportPreviewResponse, HrError> {
        let period = Some((date!(2026 - 10 - 01), date!(2026 - 10 - 31)));
        self.preview_for(file, sheets, mapping, period).await
    }

    /// [`Self::preview`] with the upload's pay period (W12: a roster has none).
    pub async fn preview_for(
        &self,
        file: &str,
        sheets: &[GridSheet],
        mapping: &WorkbookMappingRequest,
        period: Option<(time::Date, time::Date)>,
    ) -> Result<EmployeeImportPreviewResponse, HrError> {
        let memory = self
            .f
            .hr
            .import_column_memory(self.f.principal.org_id)
            .await?;
        let ctx = SheetContext {
            filename: file,
            org: self.org(),
            vault: Some(&MirrorVault),
        };
        let parsed = parse_workbook(&ctx, sheets, &memory, mapping)?;
        let upload = XlsxUpload {
            filename: file.into(),
            bytes: Vec::new(),
            mapping: None,
            pay_period_start: period.map(|p| p.0),
            pay_period_end: period.map(|p| p.1),
        };
        self.f
            .hr
            .preview_import(self.f.principal.clone(), upload, "b".repeat(64), parsed)
            .await
    }

    pub async fn dry_run(&self, run: Uuid, decisions: Decisions) -> EmployeeImportDryRunSummary {
        self.try_dry_run(run, decisions).await.unwrap()
    }

    pub async fn try_dry_run(
        &self,
        run: Uuid,
        decisions: Decisions,
    ) -> Result<EmployeeImportDryRunSummary, HrError> {
        self.f
            .hr
            .dry_run_import(
                self.f.principal.clone(),
                run,
                ImportDryRunRequest { decisions },
            )
            .await
    }

    pub async fn apply(&self, run: Uuid, digest: &str) -> Result<EmployeeImportReport, HrError> {
        self.f
            .hr
            .apply_import(
                self.f.principal.clone(),
                self.store.clone(),
                run,
                EmployeeImportApplyRequest {
                    dry_run_digest: digest.into(),
                },
            )
            .await
    }

    /// Preview with no mapping, dry run with `decisions`, apply.
    pub async fn load(
        &self,
        file: &str,
        sheets: &[GridSheet],
        decisions: Decisions,
    ) -> EmployeeImportReport {
        let run = self
            .preview(file, sheets, &WorkbookMappingRequest::default())
            .await
            .unwrap()
            .run_id;
        let plan = self.dry_run(run, decisions).await;
        assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
        self.apply(run, &plan.dry_run_digest).await.unwrap()
    }

    /// `(id, 사번, status)` by name (names are unique in these tests).
    pub async fn person(&self, name: &str) -> (Uuid, Option<String>, String) {
        sqlx::query_as(
            "SELECT id, employee_number, employment_status FROM employees \
             WHERE org_id = $1 AND name = $2",
        )
        .bind(self.org())
        .bind(name)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    /// An ACTIVE 부서 of this tenant named `name` (W03).
    pub async fn unit(&self, name: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
            .bind(self.org())
            .bind(id)
            .execute(&self.owner)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO org_unit_revisions \
             (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
             VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('00', 32), 'hex'), \
                     jsonb_build_object('name', $4::TEXT, 'kind', 'department'), '{}'::jsonb)",
        )
        .bind(self.org())
        .bind(id)
        .bind(*self.f.principal.user_id.as_uuid())
        .bind(name)
        .execute(&self.owner)
        .await
        .unwrap();
        id
    }

    pub async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
            .bind(self.org())
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

pub fn decisions() -> Decisions {
    Decisions::default()
}

pub fn map<V: Clone>(pairs: &[(&str, V)]) -> BTreeMap<String, V> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect()
}
