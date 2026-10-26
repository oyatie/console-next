//! 접속기록 capture for HR reads of personal data (INF-02, amended by
//! GOV-PEO-1): the directory list, detail and export, exit cases, lifecycle
//! history and the org chart. The record itself is built by the shared
//! `console_platform_request_context::audit_context::access_log`; this module
//! names the HR 수행업무 and resolves the reader's own employee record.

use console_kernel_core::AuditEvent;
use console_platform_authz::Principal;
use console_platform_request_context::audit_context::access_log::{self, AccessRecord};
use serde_json::{Value, json};
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;

/// The 수행업무 of an HR read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectoryAccess {
    /// 목록 조회: one row per list page, naming the subjects on it.
    List,
    /// 조회: one employee's detail.
    Detail,
    /// 다운로드: the CSV export, with its 용도.
    Download,
    /// A download refused before any byte (no or unknown 용도).
    DownloadRefused,
    /// 퇴사 건 목록 조회: one row per page, naming the employees on it.
    ExitCaseList,
    /// 퇴사 건 조회: one case (target), its employee (subject).
    ExitCase,
    /// 인사 이력 조회: one employee's lifecycle events.
    LifecycleHistory,
    /// 조직도 조회: the whole chart, recorded by its row count like a download.
    OrgChart,
    /// IMPORT-2: 주민등록번호 열람 (the full number, with its 사유).
    RrnReveal,
    FieldReveal,
    PersonBindingReview,
}

impl DirectoryAccess {
    const fn action(self) -> &'static str {
        match self {
            Self::List => "employee.list_read",
            Self::Detail => "employee.read",
            Self::Download => "employee.export",
            Self::DownloadRefused => "employee.export_refused",
            Self::ExitCaseList => "employee_exit_case.list_read",
            Self::ExitCase => "employee_exit_case.read",
            Self::LifecycleHistory => "employee.lifecycle_read",
            Self::OrgChart => "employee.org_chart_read",
            Self::RrnReveal => "employee.rrn_reveal",
            Self::FieldReveal => "employee.field_reveal",
            Self::PersonBindingReview => "person_binding_reviews.read",
        }
    }

    const fn target_type(self) -> &'static str {
        match self {
            Self::ExitCaseList | Self::ExitCase => "employee_exit_case",
            Self::PersonBindingReview => "person_binding_review",
            _ => "employee",
        }
    }
}

/// The employee record linked to the reading account, if any.
pub async fn actor_employee_id(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    principal: &Principal,
) -> Result<Option<Uuid>, HrError> {
    Ok(
        sqlx::query_scalar("SELECT employee_id FROM users WHERE org_id = $1 AND id = $2")
            .bind(*principal.org_id.as_uuid())
            .bind(*principal.user_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?
            .flatten(),
    )
}

/// One 접속기록 row. `target_id` is the employee id for a detail or history
/// read and `query` otherwise; `details` adds kind-specific fields (export
/// 용도, row count).
pub fn access_event(
    principal: &Principal,
    access: DirectoryAccess,
    subject_ids: &[Uuid],
    actor_employee: Option<Uuid>,
    details: Value,
) -> Result<AuditEvent, HrError> {
    let target_id = match (access, subject_ids) {
        (
            DirectoryAccess::Detail
            | DirectoryAccess::LifecycleHistory
            | DirectoryAccess::RrnReveal
            | DirectoryAccess::FieldReveal,
            [one],
        ) => one.to_string(),
        _ => "query".to_owned(),
    };
    access_event_on(
        principal,
        access,
        target_id,
        subject_ids,
        actor_employee,
        details,
    )
}

/// [`access_event`] with an explicit target (an exit case's id).
pub fn access_event_on(
    principal: &Principal,
    access: DirectoryAccess,
    target_id: String,
    subject_ids: &[Uuid],
    actor_employee: Option<Uuid>,
    details: Value,
) -> Result<AuditEvent, HrError> {
    let mut extra = json!({ "actor_employee_id": actor_employee });
    if let (Some(extra), Value::Object(details)) = (extra.as_object_mut(), details) {
        extra.extend(details);
    }
    access_log::access_event(
        principal,
        AccessRecord {
            action: access.action(),
            target_type: access.target_type(),
            target_id,
            subject_ids,
            reader_subject: actor_employee,
            details: extra,
        },
    )
    .map_err(HrError::from_kernel)
}

/// The 접속기록 of an import run's rows shown back (preview, dry-run): the
/// request's IP, session and principal type ride along. The rows are not
/// employees yet, so the counts ride in `after` instead of subject ids.
pub fn import_rows_event(
    principal: &Principal,
    action: &'static str,
    run_id: Uuid,
    after: Value,
) -> Result<AuditEvent, HrError> {
    import_event(principal, action, run_id.to_string(), &[], after)
}

fn import_event(
    principal: &Principal,
    action: &'static str,
    target_id: String,
    subject_ids: &[Uuid],
    details: Value,
) -> Result<AuditEvent, HrError> {
    let record = AccessRecord {
        action,
        target_type: "data_import_run",
        target_id,
        subject_ids,
        reader_subject: None,
        details,
    };
    access_log::access_event(principal, record)
        .map(|event| event.with_source(console_kernel_core::AuditSource::Import))
        .map_err(HrError::from_kernel)
}
