//! The BW-10 test harness: a run staged from typed lines, dry-run and apply on
//! a `console_rt` runtime pool and a `console_leave_cmd` command pool.

use std::sync::Arc;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::import::parsed::{
    EmployeeCanonicalFields, ImportRowStatus, ParsedEmployeeImportRow, ParsedEmployeeImportWorkbook,
};
use console_hr_adapter_postgres::import::types::{
    EmployeeImportApplyRequest, EmployeeImportDryRunSummary, EmployeeImportReport,
    ImportDryRunRequest, XlsxUpload,
};
use console_hr_domain::import::plan::Decisions;
use console_inbox_adapter_postgres::PgInboxStore;
use console_leave_adapter_postgres::PgLeaveStore;
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::macros::date;
use uuid::Uuid;

use crate::fixture::{Fixture, fixture};

#[path = "../../../../entity/adapter-postgres/tests/common/mod.rs"]
mod entity_fixture;

/// One workbook row: 사번, 성명, 부서, 직위, 입사일 (+ optional cells).
#[derive(Clone, Default)]
pub struct Line {
    pub number: Option<&'static str>,
    pub name: &'static str,
    pub unit: Option<&'static str>,
    pub position: Option<&'static str>,
    pub job: Option<&'static str>,
    pub hire: Option<String>,
    pub exit: Option<&'static str>,
    pub leave: Option<&'static str>,
    /// 고용형태 (MR-7).
    pub kind: Option<&'static str>,
    /// 사업장 text (MR-7).
    pub site: Option<&'static str>,
}

pub fn line(number: &'static str, name: &'static str) -> Line {
    Line {
        number: Some(number),
        name,
        unit: Some("본사"),
        position: Some("사원"),
        hire: Some("2024-03-04".into()),
        ..Line::default()
    }
}

pub struct Importer {
    pub f: Fixture,
    pub store: PgLeaveStore,
    pub owner: PgPool,
    pub entity: Uuid,
    pub workplace: Uuid,
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
    let mut f = fixture(pool.clone()).await;
    let actor = console_entity_application::Actor {
        org: f.principal.org_id,
        user: f.principal.user_id,
        trace: console_kernel_core::TraceContext::generate(),
        command_id: None,
        scope: console_entity_application::EntityScope::Tenant,
    };
    let entities = console_entity_adapter_postgres::PgEntityStore::new(f.rt.clone());
    let mut input = entity_fixture::corporation("주식회사 가나", "000211-0006241");
    input.display_name = Some("Co".into());
    let entity = entities
        .create_entity(&entity_fixture::cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;
    let registration = entities
        .create_registration(
            &entity_fixture::cmd(&actor),
            entity,
            entity_fixture::certificate("000-81-00009"),
        )
        .await
        .unwrap()
        .record
        .id;
    let workplace = entities
        .create_workplace(
            &entity_fixture::cmd(&actor),
            entity,
            entity_fixture::workplace_from(registration, "본사"),
            entity_fixture::port(),
        )
        .await
        .unwrap()
        .record;
    f.unit = workplace.org_unit_id.unwrap();
    let store = PgLeaveStore::new(f.rt.clone(), Arc::new(PgInboxStore::new(f.rt.clone())))
        .with_leave_command_pool(command);
    Importer {
        f,
        store,
        owner: pool,
        entity,
        workplace: workplace.id,
    }
}

impl Importer {
    /// Stages `lines` as a PREVIEWED run of `filename` (rows 2.. of 명부).
    pub async fn preview(&self, filename: &str, lines: &[Line]) -> Uuid {
        let rows = lines
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let row = i32::try_from(i).unwrap() + 2;
                ParsedEmployeeImportRow {
                    company: "Co".into(),
                    name: Some(l.name.into()),
                    source_filename: filename.into(),
                    source_sheet: "명부".into(),
                    source_row: row,
                    source_key: format!("filename:{filename}|sheet:명부|row:{row}"),
                    raw_row: json!({ "성명": l.name, "사번": l.number }),
                    source_metadata: json!({}),
                    canonical: Some(EmployeeCanonicalFields {
                        employee_number: l.number.map(Into::into),
                        org_unit: l.unit.map(Into::into),
                        position: l.position.map(Into::into),
                        job: l.job.map(Into::into),
                        hire_date: l.hire.clone(),
                        exit_date: l.exit.map(Into::into),
                        employment_status: "ACTIVE".into(),
                        leave_accrued: l.leave.map(Into::into),
                        leave_used: l.leave.map(|_| "0.000000".into()),
                        leave_remaining: l.leave.map(Into::into),
                        employment_type: l.kind.map(Into::into),
                        worksite_name: l.site.map(Into::into),
                        ..EmployeeCanonicalFields::default()
                    }),
                    row_status: ImportRowStatus::Candidate,
                }
            })
            .collect();
        let upload = XlsxUpload {
            filename: filename.into(),
            bytes: Vec::new(),
            mapping: None,
            pay_period_start: Some(date!(2026 - 10 - 01)),
            pay_period_end: Some(date!(2026 - 10 - 31)),
        };
        let parsed = ParsedEmployeeImportWorkbook {
            rows,
            ..ParsedEmployeeImportWorkbook::default()
        };
        self.f
            .hr
            .preview_import(self.f.principal.clone(), upload, "a".repeat(64), parsed)
            .await
            .unwrap()
            .run_id
    }

    pub async fn dry_run(
        &self,
        run: Uuid,
        mut decisions: Decisions,
    ) -> EmployeeImportDryRunSummary {
        let source = console_hr_domain::import::plan::ImportRow {
            company: "Co".into(),
            ..Default::default()
        };
        decisions
            .company_map
            .entry(console_hr_domain::import::company_review::company_key(
                &source,
            ))
            .or_insert(Some(self.workplace));
        self.f
            .hr
            .dry_run_import(
                self.f.principal.clone(),
                run,
                ImportDryRunRequest { decisions },
            )
            .await
            .unwrap()
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

    /// Preview, dry run without decisions, apply.
    pub async fn load(&self, filename: &str, lines: &[Line]) -> EmployeeImportReport {
        let run = self.preview(filename, lines).await;
        let plan = self.dry_run(run, Decisions::default()).await;
        self.apply(run, &plan.dry_run_digest).await.unwrap()
    }

    pub async fn person(
        &self,
        number: &str,
    ) -> (Uuid, String, String, Option<String>, Option<String>) {
        sqlx::query_as(
            "SELECT id, name, employment_status, position, exit_date::TEXT FROM employees \
             WHERE org_id = $1 AND employee_number = $2",
        )
        .bind(*self.f.principal.org_id.as_uuid())
        .bind(number)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }
}
