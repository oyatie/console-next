// SPDX-License-Identifier: LicenseRef-Proprietary
//! Digest-bound, all-or-nothing import reversal through the existing correction and void writers.

#[path = "rollback_execute.rs"]
mod execute;
#[path = "rollback_plan.rs"]
mod plan;

use console_hr_domain::import::rollback::{Basis, Blocker, InverseRow};
use console_hr_domain::requests::ChangeRequestKind;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind, PasskeyService,
};
use console_platform_authz::cedar_pbac::actions::import_rollback::{self, RollbackFacts};
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
};
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::corrections::{SecondPersonContext, refusal};
use crate::lifecycle::title_reason::validate_reason_code;
use crate::requests::ChangeRequestResponse;
use crate::requests::create::{NewChangeRequest, insert_change_request_in_tx};
use crate::{HrError, HrService};
use console_settings_domain::code_lists::ReasonDomain;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RollbackRequest {
    pub preview_digest: String,
    #[serde(default)]
    pub acknowledged: bool,
    pub reason_code: Option<String>,
    pub note: Option<String>,
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}

pub struct RollbackCredentials {
    pub passkeys: Option<PasskeyService>,
    pub idempotency_key: String,
}

#[derive(Debug, Serialize)]
pub struct RollbackPreview {
    pub run_id: Uuid,
    pub mode: &'static str,
    pub basis: Basis,
    #[serde(with = "time::serde::rfc3339::option")]
    pub window_until: Option<OffsetDateTime>,
    pub window_days: i64,
    pub rows: Vec<InverseRow>,
    pub blockers: Vec<Blocker>,
    pub preview_digest: String,
    pub allowed: Vec<&'static str>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RollbackOutcome {
    pub run_id: Uuid,
    pub status: String,
    pub request_id: Option<Uuid>,
    pub review_required: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    pub rolled_back_at: Option<OffsetDateTime>,
}

pub fn rollback_binding(run: Uuid, digest: &str) -> MobilePasskeyStepUpBinding {
    let kind = MobileStepUpActionKind::ExceptionDecide;
    MobilePasskeyStepUpBinding {
        action_kind: kind,
        object_id: run,
        reason_key: kind.expected_reason_key().to_owned(),
        replay_attempt: None,
        payload_hash: Some(crate::digest::sha256_hex(digest.as_bytes())),
    }
}

pub(crate) fn coded(code: &'static str) -> HrError {
    let status = match code {
        "import_run_not_found" => http::StatusCode::NOT_FOUND,
        "import_rollback_ack_required" | "reason_code" => http::StatusCode::UNPROCESSABLE_ENTITY,
        "step_up_required" | "step_up_failed" => http::StatusCode::UNAUTHORIZED,
        "import_rollback_sole_holder_refused" | "authz_sod_requester" => {
            http::StatusCode::FORBIDDEN
        }
        _ => http::StatusCode::CONFLICT,
    };
    refusal(status, code, code)
}

pub(crate) fn enforce(principal: &Principal, facts: RollbackFacts) -> Result<(), HrError> {
    let org = principal.org_id.to_string();
    if import_rollback::decide(&principal.user_id.to_string(), &org, &org, &facts).unwrap_or(false)
    {
        Ok(())
    } else if facts.actor_is_requester && !facts.filing {
        Err(coded("authz_sod_requester"))
    } else {
        Err(coded("import_rollback_sole_holder_refused"))
    }
}

pub(super) fn event(
    principal: &Principal,
    run: Uuid,
    action: &str,
    after: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "data_import_run",
        run.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(principal.org_id)
    .with_snapshots(None, Some(after)))
}

fn measured<T>(
    stage: &'static str,
    start: std::time::Instant,
    result: Result<T, HrError>,
) -> Result<T, HrError> {
    crate::metrics::record_import_rollback(stage, start.elapsed().as_secs_f64());
    if result.is_err() {
        crate::metrics::record_import_rollback("rollback_refused", 0.0);
    }
    result
}

impl HrService {
    pub async fn preview_import_rollback(
        &self,
        principal: Principal,
        run: Uuid,
    ) -> Result<RollbackPreview, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let start = std::time::Instant::now();
        let result = with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let loaded = plan::load(tx, &principal, run, None, false).await?;
                Ok(loaded.preview)
            })
        })
        .await;
        measured("rollback_preview", start, result)
    }

    pub async fn rollback_import(
        &self,
        principal: Principal,
        run: Uuid,
        body: RollbackRequest,
        credentials: Option<RollbackCredentials>,
        holders: SecondPersonContext,
    ) -> Result<RollbackOutcome, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let start = std::time::Instant::now();
        let result = with_audits::<_,_,HrError>(&self.pool, principal.org_id, move |tx| Box::pin(async move {
            let org = *principal.org_id.as_uuid();
            let me = *principal.user_id.as_uuid();
            let operation = format!("employee_import.rollback:{run}:{me}");
            // A step-up assertion is consumable, so replay compares the stable command only.
            let fingerprint = json!({"preview_digest":body.preview_digest,"acknowledged":body.acknowledged,
                "reason_code":body.reason_code,"note":body.note});
            if let Some(c) = &credentials {
                match claim_idempotency_key(tx,&operation,&c.idempotency_key,&fingerprint).await? {
                    IdempotencyClaim::Replay(value) => return Ok((serde_json::from_value(value).map_err(|_|HrError::internal("rollback replay"))?,vec![])),
                    IdempotencyClaim::Mismatch => return Err(crate::idempotency::idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
            }
            let loaded = plan::load(tx,&principal,run,None,true).await?;
            let p = &loaded.preview;
            check_digest(p,&body.preview_digest)?;
            if p.mode == "SETUP" && !body.acknowledged { return Err(coded("import_rollback_ack_required")); }
            let reason = if p.mode == "SETUP" { "IMPORT_ROLLBACK".to_owned() } else {
                let code = body.reason_code.as_deref().ok_or_else(||coded("reason_code"))?;
                validate_reason_code(tx,principal.org_id,ReasonDomain::ImportRollback,code,body.note.as_deref()).await
                    .map_err(|_|coded("reason_code"))?;
                code.to_owned()
            };
            let note = crate::requests::note(body.note.as_deref())?;
            let mut holders = holders;
            holders.routed = loaded.routed;
            let route = p.mode != "SETUP" && loaded.routed && holders.other_eligible_holders > 0;
            let review = p.mode != "SETUP" && loaded.routed && !route;
            let needs_step = p.mode != "SETUP" && !route;
            if review && holders.sole_holder_refuse { return Err(coded("import_rollback_sole_holder_refused")); }
            if needs_step {
                let envelope = body.step_up.ok_or_else(||coded("step_up_required"))?;
                let passkeys = credentials.as_ref().and_then(|c|c.passkeys.as_ref()).ok_or_else(||coded("step_up_required"))?;
                passkeys.verify_and_record_step_up_in_tx(tx,envelope,me,&rollback_binding(run,&p.preview_digest)).await.map_err(|_|coded("step_up_failed"))?;
            }
            enforce(&principal,RollbackFacts {actor_holds_permission:true,setup:p.mode=="SETUP",routed:loaded.routed,
                other_eligible_holders:i64::try_from(holders.other_eligible_holders).unwrap_or(i64::MAX),sole_holder_refuse:holders.sole_holder_refuse,
                step_up:needs_step,filing:true,actor_is_requester:true})?;
            let (outcome,audits) = if route {
                let request = insert_change_request_in_tx(tx,NewChangeRequest {org,kind:ChangeRequestKind::ImportRollback,
                    subject_type:"DATA_IMPORT_RUN",subject_id:run,payload:&json!({"preview_digest":p.preview_digest}),
                    reason_code:&reason,note:note.as_deref(),requested_by:me,assignee_user_id:None}).await?;
                let audit = event(&principal,run,"data_import.rollback_request",json!({"requester":me,"request_id":request.id,
                    "reason_code":reason,"digest":p.preview_digest,"mode":p.mode}))?;
                (RollbackOutcome {run_id:run,status:"ROLLBACK_REQUESTED".into(),request_id:Some(request.id),review_required:false,rolled_back_at:None},vec![audit])
            } else {
                execute::apply(tx,&principal,run,&loaded,&reason,note.as_deref(),None,review).await?
            };
            if let Some(c)=credentials { complete_idempotency_key(tx,&operation,&c.idempotency_key,&serde_json::to_value(&outcome).map_err(|_|HrError::internal("rollback outcome"))?).await?; }
            Ok((outcome,audits))
        })).await;
        let stage = match &result {
            Ok(out) if out.status == "ROLLBACK_REQUESTED" => "rollback_request",
            _ => "rollback",
        };
        measured(stage, start, result)
    }
}

pub async fn apply_requested_rollback_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    request: &ChangeRequestResponse,
    holders: SecondPersonContext,
) -> Result<Vec<AuditEvent>, HrError> {
    authorize_hr_org_wide(principal, Feature::EmployeeDirectoryManage)?;
    enforce(
        principal,
        RollbackFacts {
            actor_holds_permission: true,
            setup: false,
            routed: true,
            other_eligible_holders: i64::try_from(holders.other_eligible_holders)
                .unwrap_or(i64::MAX),
            sole_holder_refuse: holders.sole_holder_refuse,
            step_up: false,
            filing: false,
            actor_is_requester: request.requested_by == *principal.user_id.as_uuid(),
        },
    )?;
    let digest = request.payload["preview_digest"]
        .as_str()
        .ok_or_else(|| HrError::validation("preview_digest required"))?;
    let loaded = plan::load(
        tx,
        principal,
        request.subject_id,
        Some((request.id, request.created_at)),
        true,
    )
    .await?;
    check_digest(&loaded.preview, digest)?;
    let (_, audits) = execute::apply(
        tx,
        principal,
        request.subject_id,
        &loaded,
        &request.reason_code,
        request.note.as_deref(),
        Some(request.requested_by),
        false,
    )
    .await?;
    crate::metrics::record_import_rollback("rollback", 0.0);
    Ok(audits)
}

pub(super) fn check_digest(preview: &RollbackPreview, digest: &str) -> Result<(), HrError> {
    if preview.preview_digest != digest {
        let mut err = coded("rows_changed_since_preview");
        err.refusals = Some(serde_json::json!([{"preview":preview}]));
        Err(err)
    } else if !preview.blockers.is_empty() {
        let mut err = coded("import_rollback_blocked");
        err.refusals = Some(
            serde_json::to_value(&preview.blockers)
                .map_err(|_| HrError::internal("rollback blockers"))?,
        );
        Err(err)
    } else {
        Ok(())
    }
}
