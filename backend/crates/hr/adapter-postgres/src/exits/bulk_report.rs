// SPDX-License-Identifier: LicenseRef-Proprietary
//! `POST /api/v1/hr/exit-cases/bulk`: batch exit-case reporting (up to 500
//! items) with set-based preloading, per-item authz + own-record + guard
//! evaluation, bulk inserts, and non-aborting per-item results.

use console_hr_domain::text::{normalize_date_text, normalize_limited_text, parse_yyyy_mm_dd};
use console_kernel_core::{AuditAction, AuditEvent, BranchId, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
};
use console_platform_db::with_audits;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Postgres;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::{authorize_hr_scoped, holds_scoped};
use crate::exits::bulk_report_eval::{AdmittedItem, evaluate_bulk_items};
use crate::exits::bulk_report_preload::load_bulk_preload;
use crate::exits::reason::checked_exit_reason;
use crate::idempotency::idempotency_key_reused;
use crate::own_record::record_break_glass;
use crate::{HrError, HrService};

pub const MAX_BULK_EXIT_ITEMS: usize = 500;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BulkExitCaseItemInput {
    pub employee_id: Uuid,
    #[serde(default)]
    pub branch_id: Option<Uuid>,
    #[serde(default)]
    pub absence_alert_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BulkReportExitCasesRequest {
    pub effective_exit_date: String,
    pub site_manager_note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_reason_code: Option<String>,
    pub items: Vec<BulkExitCaseItemInput>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BulkExitCaseItemResult {
    pub employee_id: Uuid,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BulkReportExitCasesResponse {
    pub results: Vec<BulkExitCaseItemResult>,
}

pub(crate) fn fail_item(employee_id: Uuid, err: &HrError) -> BulkExitCaseItemResult {
    BulkExitCaseItemResult {
        employee_id,
        ok: false,
        case_id: None,
        code: Some(err.code.to_owned()),
        message: Some(err.message.clone()),
    }
}

impl HrService {
    pub async fn bulk_report_exit_cases(
        &self,
        principal: Principal,
        idempotency_key: String,
        body: BulkReportExitCasesRequest,
    ) -> Result<(StatusCode, Value), HrError> {
        if body.items.is_empty() || body.items.len() > MAX_BULK_EXIT_ITEMS {
            return Err(HrError::validation(
                "items must contain between 1 and 500 entries",
            ));
        }
        let scoped = holds_scoped(&principal, Feature::ExitCaseReport);
        if !scoped {
            authorize_hr_scoped(&principal, Feature::ExitCaseReport)?;
        }
        let fingerprint = json!(&body);
        let effective_exit_date = normalize_date_text(&body.effective_exit_date)?;
        let exit_date_parsed = parse_yyyy_mm_dd(&effective_exit_date)?;
        let site_manager_note =
            normalize_limited_text(body.site_manager_note, 1000, "site_manager_note")?;
        let actor = principal.user_id;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let items = body.items;
        let exit_reason_code_req = body.exit_reason_code;

        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                const OPERATION: &str = "hr.exit_case.bulk_create";
                match claim_idempotency_key(tx, OPERATION, &idempotency_key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => {
                        return Ok(((StatusCode::OK, response), vec![]));
                    }
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }

                let exit_reason = checked_exit_reason(
                    tx,
                    org,
                    exit_reason_code_req.as_deref(),
                    &site_manager_note,
                )
                .await?;
                let exit_reason_code = exit_reason.as_ref().map(|r| r.code.clone());
                let preload = load_bulk_preload(tx, &principal, org, actor, &items).await?;
                let (mut results, admitted) = evaluate_bulk_items(
                    tx,
                    &principal,
                    org,
                    &items,
                    &effective_exit_date,
                    exit_date_parsed,
                    exit_reason.as_ref(),
                    &preload,
                )
                .await?;

                let mut events = Vec::with_capacity(admitted.len());
                if !admitted.is_empty() {
                    persist_admitted(
                        tx,
                        org,
                        org_uuid,
                        actor,
                        &effective_exit_date,
                        &site_manager_note,
                        exit_reason_code.as_deref(),
                        admitted,
                        &mut results,
                        &mut events,
                    )
                    .await?;
                }

                let final_results: Vec<BulkExitCaseItemResult> =
                    results.into_iter().flatten().collect();
                let response = serde_json::to_value(BulkReportExitCasesResponse {
                    results: final_results,
                })
                .map_err(|_| HrError::internal("response serialization failed"))?;
                complete_idempotency_key(tx, OPERATION, &idempotency_key, &response).await?;
                Ok(((StatusCode::OK, response), events))
            })
        })
        .await
    }
}

#[allow(clippy::too_many_arguments)]
async fn persist_admitted(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: console_kernel_core::OrgId,
    org_uuid: Uuid,
    actor: console_kernel_core::UserId,
    effective_exit_date: &str,
    site_manager_note: &str,
    exit_reason_code: Option<&str>,
    admitted: Vec<AdmittedItem>,
    results: &mut [Option<BulkExitCaseItemResult>],
    events: &mut Vec<AuditEvent>,
) -> Result<(), HrError> {
    let case_ids: Vec<Uuid> = admitted.iter().map(|a| a.case_id).collect();
    let emp_vec: Vec<Uuid> = admitted.iter().map(|a| a.employee_id).collect();
    let branch_vec: Vec<Option<Uuid>> = admitted.iter().map(|a| a.branch_id).collect();
    let alert_vec: Vec<Option<Uuid>> = admitted.iter().map(|a| a.absence_alert_id).collect();

    sqlx::query(
        "INSERT INTO employee_exit_cases ( \
             id, org_id, employee_id, branch_id, absence_alert_id, \
             effective_exit_date, site_manager_note, reported_by, exit_reason_code \
         ) \
         SELECT u.id, $1, u.employee_id, u.branch_id, u.absence_alert_id, \
                $6::DATE, $7, $8, $9 \
         FROM UNNEST($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[]) \
           AS u(id, employee_id, branch_id, absence_alert_id)",
    )
    .bind(org_uuid)
    .bind(&case_ids)
    .bind(&emp_vec)
    .bind(&branch_vec)
    .bind(&alert_vec)
    .bind(effective_exit_date)
    .bind(site_manager_note)
    .bind(*actor.as_uuid())
    .bind(exit_reason_code)
    .execute(tx.as_mut())
    .await?;

    crate::cases::open::exit_many(tx, org_uuid, &case_ids).await?;

    let linked_alerts: Vec<(Uuid, Uuid)> = admitted
        .iter()
        .filter_map(|a| a.absence_alert_id.map(|al| (al, a.case_id)))
        .collect();
    if !linked_alerts.is_empty() {
        let al_ids: Vec<Uuid> = linked_alerts.iter().map(|(a, _)| *a).collect();
        let cs_ids: Vec<Uuid> = linked_alerts.iter().map(|(_, c)| *c).collect();
        sqlx::query(
            "UPDATE employee_absence_alerts a \
             SET status = 'LINKED_EXIT', linked_exit_case_id = u.case_id, updated_at = now() \
             FROM UNNEST($2::uuid[], $3::uuid[]) AS u(alert_id, case_id) \
             WHERE a.org_id = $1 AND a.id = u.alert_id",
        )
        .bind(org_uuid)
        .bind(&al_ids)
        .bind(&cs_ids)
        .execute(tx.as_mut())
        .await?;
    }

    for item in admitted {
        if item.sole_holder_ops {
            record_break_glass(tx, org, actor, item.employee_id, Feature::ExitCaseReport).await?;
        }
        let mut event = AuditEvent::new(
            Some(actor),
            AuditAction::new("employee.exit.report").map_err(HrError::from_kernel)?,
            "employee",
            item.employee_id.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(org)
        .with_snapshots(
            None,
            Some(json!({
                "employee_id": item.employee_id,
                "case_id": item.case_id,
                "absence_alert_id": item.absence_alert_id,
                "effective_exit_date": effective_exit_date,
                "exit_reason_code": exit_reason_code,
                "branch_id": item.branch_id,
                "requested_branch_id": item.requested_branch_id,
                "bulk": true,
            })),
        );
        if let Some(branch_id) = item.branch_id {
            event = event.with_branch(BranchId::from_uuid(branch_id));
        }
        events.push(event);
        results[item.index] = Some(BulkExitCaseItemResult {
            employee_id: item.employee_id,
            ok: true,
            case_id: Some(item.case_id),
            code: None,
            message: None,
        });
    }
    Ok(())
}
