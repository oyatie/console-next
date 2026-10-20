//! Decisions and requester receipts for pending identifier-correction exceptions.
use super::corrections::{correction_contributors, governance_kernel};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use console_governance_adapter_postgres::{
    PgGovernanceError,
    exception::{ExceptionDecision, decide_exception_conn, get_exception_conn},
};
use console_governance_domain::exception::{Decision, RuleCode, SubjectType};
use console_kernel_core::{ErrorKind, KernelError};
use console_platform_auth::{
    JwtVerifier, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind,
    PasskeyService,
};
use console_platform_authz::{Action, Feature, authorize_capability};
use sqlx::PgPool;
#[derive(Clone)]
struct EntityWiringState {
    pool: PgPool,
    jwt: Option<JwtVerifier>,
    passkeys: Option<PasskeyService>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DecideExceptionRequest {
    decision: String,
    reason_code: String,
    note: Option<String>,
    step_up: Option<serde_json::Value>,
}

async fn decide_exception(
    State(state): State<EntityWiringState>,
    Path(id): Path<uuid::Uuid>,
    headers: HeaderMap,
    Json(body): Json<DecideExceptionRequest>,
) -> Response {
    let Some(verifier) = state.jwt.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": {"code": "unavailable", "message": "JWT verifier is unavailable"}})),
        ).into_response();
    };
    let principal = match console_platform_request_context::resolve_principal(
        verifier,
        &state.pool,
        &headers,
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            let (status, code) = match e {
                console_platform_request_context::RequestContextError::MissingBearer
                | console_platform_request_context::RequestContextError::InvalidToken
                | console_platform_request_context::RequestContextError::InvalidClaim(_) => {
                    (StatusCode::UNAUTHORIZED, "unauthorized")
                }
                console_platform_request_context::RequestContextError::WrongTokenTier
                | console_platform_request_context::RequestContextError::AccessScope(_) => {
                    (StatusCode::FORBIDDEN, "forbidden")
                }
                _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
            };
            return (status, Json(serde_json::json!({"error": {"code": code, "message": "authentication failed"}}))).into_response();
        }
    };

    let decision = match body.decision.trim() {
        "APPROVE" | "approve" => Decision::Approve,
        "DECLINE" | "decline" => Decision::Decline,
        _ => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": {"code": "validation_failed", "message": "invalid decision"}})),
            ).into_response();
        }
    };

    let result: Result<_, PgGovernanceError> = console_platform_db::with_audits(
        &state.pool, principal.org_id, move |tx| Box::pin(async move {
            // Lock before deriving binding and decision snapshots.
            sqlx::query("SELECT id FROM governed_exceptions WHERE id = $1 FOR UPDATE")
                .bind(id).fetch_optional(tx.as_mut()).await?;
            let stored = get_exception_conn(tx.as_mut(), id).await?
                .ok_or_else(|| KernelError::not_found("exception_not_found"))?;
            // This seam owns identifier corrections; other rules need their own permission resolver.
            if stored.rule != RuleCode::EntityIdentifierCorrection {
                return Err(KernelError::forbidden("exception_rule_unsupported").into());
            }
            let contributed = correction_contributors(tx, stored.subject_type, stored.subject_id)
                .await?.contains(&principal.user_id);
            let binding = MobilePasskeyStepUpBinding::bound(
                MobileStepUpActionKind::ExceptionDecide, stored.id, stored.fingerprint.clone(),
            );
            let step_up_assertion_id = if let Some(value) = body.step_up {
                let passkeys = state.passkeys.as_ref().ok_or_else(|| KernelError::internal("passkeys unavailable"))?;
                let envelope: MobilePasskeyStepUpEnvelope = serde_json::from_value(value)
                    .map_err(|_| KernelError::forbidden("step_up_required"))?;
                Some(passkeys.verify_and_record_step_up_in_tx(tx, envelope, *principal.user_id.as_uuid(), &binding)
                    .await.map_err(|_| KernelError::forbidden("step_up_required"))?)
            } else { None };
            let holds_permission = principal.branch_scope == console_kernel_core::BranchScope::All
                && authorize_capability(&principal, Action::new(Feature::OrgChangeApply)).is_ok();
            let input = ExceptionDecision {
                decision, decider: &principal, contributed, holds_permission,
                step_up_assertion_id, reason_code: &body.reason_code, note: body.note.as_deref(),
            };
            let status = decide_exception_conn(tx.as_mut(), id, &input).await?;
            let event = console_kernel_core::AuditEvent::new(
                Some(principal.user_id), console_kernel_core::AuditAction::new("exception.decide")?,
                "governed_exception", id.to_string(), console_kernel_core::TraceContext::generate(), time::OffsetDateTime::now_utc(),
            ).with_org(principal.org_id).with_snapshots(
                Some(serde_json::json!({"status": stored.status.as_db_str(), "requested_by": stored.requested_by})),
                Some(serde_json::json!({"status": status.as_db_str(), "decided_by": principal.user_id, "reason_code": body.reason_code, "note": body.note, "step_up_assertion_id": step_up_assertion_id})),
            );
            Ok((status, vec![event]))
        }),
    ).await;
    let status = match result {
        Ok(status) => status,
        Err(error) => return decision_error(governance_kernel(error)),
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "id": id,
            "status": status.as_db_str(),
        })),
    )
        .into_response()
}

fn decision_error(error: KernelError) -> Response {
    let status = match error.kind {
        ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
        ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(serde_json::json!({"error": {"code": error.code.unwrap_or(error.message.as_str()), "message": error.message}}))).into_response()
}

pub(super) fn read_correction_outcome<'a>(
    pool: &'a PgPool,
    principal: &'a console_platform_authz::Principal,
    outcome: &'a mut console_platform_db::command_outcomes::CommandOutcome,
) -> console_platform_request_context::record_access::outcome::ReadFuture<'a> {
    Box::pin(async move {
        if !outcome.command.ends_with("/identifier-corrections") {
            return console_platform_request_context::record_access::all_readable(
                pool,
                principal,
                &outcome.touched,
            )
            .await;
        }
        let Some(id) = outcome
            .touched
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["type"] == "governed_exception")
            })
            .and_then(|item| item["id"].as_str())
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
        else {
            return console_platform_request_context::record_access::all_readable(
                pool,
                principal,
                &outcome.touched,
            )
            .await;
        };
        let stored = console_platform_db::with_org_conn::<_, _, PgGovernanceError>(
            pool,
            principal.org_id,
            move |tx| Box::pin(async move { get_exception_conn(tx.as_mut(), id).await }),
        )
        .await;
        let Ok(Some(stored)) = stored else {
            return false;
        };
        if stored.rule != RuleCode::EntityIdentifierCorrection
            || stored.requested_by != principal.user_id
        {
            return false;
        }
        let kind = match stored.subject_type {
            SubjectType::LegalEntity => "legal_entity",
            SubjectType::BusinessRegistration => "business_registration",
            _ => return false,
        };
        if !console_platform_request_context::record_access::may_read(
            pool,
            principal,
            kind,
            &stored.subject_id.to_string(),
            None,
        )
        .await
        {
            return false;
        }
        // Replay only this receipt, including when the response was lost after commit.
        outcome.result = Some(
            serde_json::json!({"status":"PENDING", "exception_id":stored.id, "payload_hash":stored.fingerprint}),
        );
        outcome.response_status = Some(202);
        true
    })
}

pub(super) fn router(
    pool: PgPool,
    jwt: Option<JwtVerifier>,
    passkeys: Option<PasskeyService>,
) -> Router {
    Router::new()
        .route("/api/v1/exceptions/{id}/decide", post(decide_exception))
        .route(
            "/api/v1/governed-exceptions/{id}/decide",
            post(decide_exception),
        )
        .with_state(EntityWiringState {
            pool,
            jwt,
            passkeys,
        })
}
