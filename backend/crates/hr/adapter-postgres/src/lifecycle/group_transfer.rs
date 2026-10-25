//! E-S3b 전적 (GROUP_TRANSFER): the facts recorded with the event
//! (design/legal-entities-and-workplaces §6, ED §3.9).
//!
//! - The employee's consent is required as an attested offline fact with its
//!   evidence (민법 §657①: an employer may not transfer its rights to a third
//!   party without the worker's consent; decisions #3: never a bare tick).
//! - Continuity is chosen per dimension, none defaulted (퇴직금, 연차, 근속;
//!   `console_hr_domain::lifecycle::group_transfer`); any carried dimension
//!   needs the succession agreement's evidence.
//! - The 그룹 입사일 is carried in either case.
//! - When the sending 법인 settles 퇴직금, its settlement case opens with the
//!   전적 (`exits::group_transfer_case`); 4대보험 상실·취득 follow the event in
//!   the statutory filings.

use serde::{Deserialize, Serialize};
use sqlx::Postgres;
use time::Date;
use uuid::Uuid;

use super::placement::WorkplaceMove;
use crate::HrError;
use crate::exits::group_transfer_case::open_settlement_case;
use console_hr_domain::lifecycle::group_transfer::Continuity;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{AuditEvent, OrgId, UserId};

/// The `group_transfer` body of a GROUP_TRANSFER request.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GroupTransferRequest {
    /// 퇴직금: SETTLED or CARRIED; required, no default.
    #[serde(default)]
    pub continuity: Option<String>,
    /// 연차: SETTLED or CARRIED. With `seniority_continuity`, or neither (then
    /// `continuity` names all three, the one-choice contract).
    #[serde(default)]
    pub annual_leave_continuity: Option<String>,
    /// 근속: RESTART or CARRIED.
    #[serde(default)]
    pub seniority_continuity: Option<String>,
    /// 그룹 입사일, ISO `YYYY-MM-DD`, on or before the start date.
    #[serde(default)]
    pub group_service_start_date: Option<String>,
    /// The day the employee consented, on or before the start date.
    #[serde(default)]
    pub consent_date: Option<String>,
    /// Attachment or document reference for the consent.
    #[serde(default)]
    pub consent_evidence_ref: Option<String>,
    /// Required when any dimension is CARRIED: the succession agreement's reference.
    #[serde(default)]
    pub succession_evidence_ref: Option<String>,
}

/// The validated facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupTransferFacts {
    pub continuity: Continuity,
    pub group_service_start_date: Date,
    pub consent_date: Date,
    pub consent_evidence_ref: String,
    pub succession_evidence_ref: Option<String>,
}

fn reference(value: Option<String>, field: &str) -> Result<Option<String>, HrError> {
    let value = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if value.as_ref().is_some_and(|v| v.chars().count() > 500) {
        return Err(HrError::validation(format!(
            "{field} must be at most 500 characters"
        )));
    }
    Ok(value)
}

fn date_by(value: Option<String>, field: &str, start: Date) -> Result<Date, HrError> {
    let raw = value.ok_or_else(|| HrError::validation(format!("{field} is required")))?;
    let date = parse_yyyy_mm_dd(raw.trim())?;
    if date > start {
        return Err(HrError::validation(format!(
            "{field} must be on or before effective_date"
        )));
    }
    Ok(date)
}

/// Validates the facts against the event: present exactly for a
/// GROUP_TRANSFER, every field the act needs, no defaults.
///
/// # Errors
/// 422 `validation` naming the field.
pub fn normalize_group_transfer(
    body: Option<GroupTransferRequest>,
    event_type: &str,
    effective_date: &str,
) -> Result<Option<GroupTransferFacts>, HrError> {
    let group = event_type.trim().eq_ignore_ascii_case("GROUP_TRANSFER");
    let body = match (body, group) {
        (None, false) => return Ok(None),
        (Some(_), false) => {
            return Err(HrError::validation(
                "group_transfer is only allowed for GROUP_TRANSFER",
            ));
        }
        (None, true) => {
            return Err(HrError::validation(
                "group_transfer is required for GROUP_TRANSFER: the consent and the continuity choice",
            ));
        }
        (Some(body), true) => body,
    };
    let start = parse_yyyy_mm_dd(effective_date.trim())?;
    let continuity = Continuity::parse(
        body.continuity.as_deref(),
        body.annual_leave_continuity.as_deref(),
        body.seniority_continuity.as_deref(),
    )
    .map_err(HrError::from_kernel)?;
    let consent_evidence_ref = reference(body.consent_evidence_ref, "consent_evidence_ref")?
        .ok_or_else(|| {
            HrError::validation("group_transfer.consent_evidence_ref is required (민법 §657①)")
        })?;
    let succession_evidence_ref =
        reference(body.succession_evidence_ref, "succession_evidence_ref")?;
    if continuity.needs_succession_evidence() && succession_evidence_ref.is_none() {
        return Err(HrError::validation(
            "group_transfer.succession_evidence_ref is required for CARRIED (포괄 승계)",
        ));
    }
    Ok(Some(GroupTransferFacts {
        continuity,
        group_service_start_date: date_by(
            body.group_service_start_date,
            "group_transfer.group_service_start_date",
            start,
        )?,
        consent_date: date_by(body.consent_date, "group_transfer.consent_date", start)?,
        consent_evidence_ref,
        succession_evidence_ref,
    }))
}

/// What a recorded 전적 writes beside its event, in the caller's transaction:
/// its facts and, when the sending 법인 settles 퇴직금, that 법인's settlement
/// case (`branch` is the person's there, read before the move). Returns the
/// case and its audit.
///
/// # Errors
/// 409 `exit_case_open` (the person's open exit case), or a database fault.
#[allow(clippy::too_many_arguments)]
pub async fn record_group_transfer_act(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    (org, actor): (OrgId, UserId),
    (employee, event): (Uuid, Uuid),
    start: &str,
    to: WorkplaceMove,
    facts: &GroupTransferFacts,
    branch: Option<Uuid>,
    note: &str,
) -> Result<(Option<Uuid>, Vec<AuditEvent>), HrError> {
    let ids = (*org.as_uuid(), event, employee, *actor.as_uuid());
    record_group_transfer(tx, ids, start, to, facts).await?;
    if !facts.continuity.opens_settlement_case() {
        crate::cases::group_transfer::link(tx, *org.as_uuid(), event, None).await?;
        return Ok((None, Vec::new()));
    }
    let on = parse_yyyy_mm_dd(start)?;
    let (case, audit) =
        open_settlement_case(tx, (org, actor), (employee, event, branch), on, note).await?;
    crate::cases::group_transfer::link(tx, *org.as_uuid(), event, Some(case)).await?;
    Ok((Some(case), vec![audit]))
}

/// Records the facts of the GROUP_TRANSFER `event` in the caller's transaction.
async fn record_group_transfer(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    ids: (Uuid, Uuid, Uuid, Uuid),
    start: &str,
    to: WorkplaceMove,
    facts: &GroupTransferFacts,
) -> Result<(), HrError> {
    let (org, event, employee, actor) = ids;
    sqlx::query(
        "INSERT INTO employee_group_transfers (org_id, lifecycle_event_id, employee_id, \
           from_legal_entity_id, to_legal_entity_id, to_workplace_id, start_date, continuity, \
           annual_leave_continuity, seniority_continuity, group_service_start_date, consent_date, \
           consent_evidence_ref, succession_evidence_ref, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7::DATE, $8, $9, $10, $11, $12, $13, $14, $15)",
    )
    .bind(org)
    .bind(event)
    .bind(employee)
    .bind(to.from_legal_entity_id)
    .bind(to.legal_entity_id)
    .bind(to.workplace_id)
    .bind(start)
    .bind(facts.continuity.severance.as_str())
    .bind(facts.continuity.annual_leave.as_str())
    .bind(facts.continuity.seniority.as_str())
    .bind(facts.group_service_start_date)
    .bind(facts.consent_date)
    .bind(&facts.consent_evidence_ref)
    .bind(facts.succession_evidence_ref.as_deref())
    .bind(actor)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn body(continuity: &str, succession: Option<&str>) -> GroupTransferRequest {
        GroupTransferRequest {
            continuity: Some(continuity.to_owned()),
            annual_leave_continuity: None,
            seniority_continuity: None,
            group_service_start_date: Some("2020-03-02".to_owned()),
            consent_date: Some("2026-10-01".to_owned()),
            consent_evidence_ref: Some("동의서 2026-10-01".to_owned()),
            succession_evidence_ref: succession.map(str::to_owned),
        }
    }

    #[test]
    fn the_facts_are_required_and_have_no_defaults() {
        let on = "2026-11-01";
        let ok = normalize_group_transfer(Some(body("SETTLED", None)), "GROUP_TRANSFER", on);
        let facts = ok.unwrap().unwrap();
        assert!(facts.continuity.opens_settlement_case());
        assert!(!facts.continuity.needs_succession_evidence());
        assert!(normalize_group_transfer(None, "GROUP_TRANSFER", on).is_err());
        assert!(normalize_group_transfer(Some(body("SETTLED", None)), "TRANSFER", on).is_err());
        assert!(
            normalize_group_transfer(None, "TRANSFER", on)
                .unwrap()
                .is_none()
        );
        let undecided = GroupTransferRequest {
            continuity: None,
            ..body("SETTLED", None)
        };
        assert!(normalize_group_transfer(Some(undecided), "GROUP_TRANSFER", on).is_err());
        // Any carried dimension needs the agreement's evidence.
        let leave_carried = GroupTransferRequest {
            annual_leave_continuity: Some("CARRIED".to_owned()),
            seniority_continuity: Some("RESTART".to_owned()),
            ..body("SETTLED", None)
        };
        assert!(normalize_group_transfer(Some(leave_carried), "GROUP_TRANSFER", on).is_err());
        assert!(
            normalize_group_transfer(Some(body("CARRIED", None)), "GROUP_TRANSFER", on).is_err()
        );
        assert!(
            normalize_group_transfer(
                Some(body("CARRIED", Some("승계 합의서"))),
                "GROUP_TRANSFER",
                on
            )
            .is_ok()
        );
        let unsigned = GroupTransferRequest {
            consent_evidence_ref: Some("  ".to_owned()),
            ..body("SETTLED", None)
        };
        assert!(normalize_group_transfer(Some(unsigned), "GROUP_TRANSFER", on).is_err());
        // Consent comes before the move.
        assert!(
            normalize_group_transfer(Some(body("SETTLED", None)), "GROUP_TRANSFER", "2026-09-30")
                .is_err()
        );
    }
}
