// SPDX-License-Identifier: LicenseRef-Proprietary
//! Written delivery facts for 근로기준법 §27, shared by confirm and apply.
use crate::HrError;
use console_hr_domain::exits::protection::{NoticeFacts, notice_missing};
use console_hr_domain::text::{normalize_optional_limited_text, parse_yyyy_mm_dd};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DismissalNotice {
    #[serde(default)]
    pub reason_text: String,
    #[serde(default)]
    pub served_on: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub evidence_ref: String,
}
impl DismissalNotice {
    pub fn facts(&self) -> NoticeFacts<'_> {
        NoticeFacts {
            reason_text: &self.reason_text,
            served_on: parse_yyyy_mm_dd(&self.served_on).ok(),
            method: &self.method,
            evidence_ref: &self.evidence_ref,
        }
    }
}
pub(super) fn missing_notice(notice: Option<&DismissalNotice>, date: Date) -> Vec<&'static str> {
    notice_missing(notice.map(DismissalNotice::facts), date)
}
pub(super) fn notice_refusal(missing: Vec<&'static str>) -> HrError {
    HrError {
        status: http::StatusCode::UNPROCESSABLE_ENTITY,
        code: "notice_evidence_missing",
        message: "written dismissal notice evidence is required".into(),
        refusals: Some(json!([{ "missing": missing }])),
    }
}
pub(super) fn checked_notice(
    required: bool,
    notice: Option<DismissalNotice>,
    date: Date,
) -> Result<Option<DismissalNotice>, HrError> {
    if !required {
        return Ok(None);
    }
    let missing = missing_notice(notice.as_ref(), date);
    if !missing.is_empty() {
        return Err(notice_refusal(missing));
    }
    let mut notice = notice.ok_or_else(|| notice_refusal(missing_notice(None, date)))?;
    notice.reason_text =
        normalize_optional_limited_text(Some(notice.reason_text), 1000, "reason_text")?
            .unwrap_or_default();
    notice.evidence_ref =
        normalize_optional_limited_text(Some(notice.evidence_ref), 1000, "evidence_ref")?
            .unwrap_or_default();
    Ok(Some(notice))
}
/// Persist before recording TERMINATE so the immediate hook sees these facts.
pub(super) async fn save_facts(
    conn: &mut Transaction<'_, Postgres>,
    org: Uuid,
    case: Uuid,
    code: &str,
    notice: Option<&DismissalNotice>,
) -> Result<(), HrError> {
    sqlx::query("UPDATE employee_exit_cases SET exit_reason_code=$3, dismissal_notice_reason=$4, dismissal_notice_served_on=$5::text::date, dismissal_notice_method=$6, dismissal_notice_evidence_ref=$7 WHERE org_id=$1 AND id=$2")
        .bind(org).bind(case).bind(code)
        .bind(notice.map(|n| &n.reason_text)).bind(notice.map(|n| &n.served_on))
        .bind(notice.map(|n| &n.method)).bind(notice.map(|n| &n.evidence_ref))
        .execute(conn.as_mut()).await?;
    sqlx::query("SELECT set_config('app.confirming_exit_case',$1,true)")
        .bind(case.to_string())
        .execute(conn.as_mut())
        .await?;
    Ok(())
}

/// Leave health facts and notice evidence reach only a scoped HR actor.
pub(super) fn mask_for_reader(
    case: &mut super::types::EmployeeExitCaseResponse,
    principal: &console_platform_authz::Principal,
) {
    use console_platform_authz::Feature;
    let may_read = [Feature::EmployeeDirectoryManage, Feature::ExitCaseHrConfirm]
        .iter()
        .any(|feature| {
            crate::authz::authorize_hr_scoped_write(principal, *feature, case.branch_id).is_ok()
        });
    if !may_read {
        case.protected_periods.clear();
        case.dismissal_notice = None;
    }
}
