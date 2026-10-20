//! Composition for the 법인 · 사업장 (`console-entity-rest`) and setup-phase
//! (`console-onboarding-rest`) faces, kept out of `lib.rs` (R1) so the
//! router merge there is one line.
//!
//! The one seam that needs the composition root: setup-phase org units are
//! written by the canonical OrgUnit owner (`org_unit::write_in_tx`), inside
//! the entity adapter's transaction — one writer, one more caller, the same
//! shape as the org-change apply seam (`PgOrgUnitWritePort` in lib.rs).

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use console_entity_adapter_juso::JusoClient;
use console_entity_adapter_postgres::{
    CorrectionCover, CorrectionSubject, GovernedCorrectionFuture, GovernedCorrectionPort, OpsCover,
    OpsCoverFuture, OrgUnitSetupFuture, OrgUnitSetupWritePort, PgEntityStore,
};
use console_entity_rest::EntityRestState;
use console_governance_adapter_postgres::PgGovernanceError;
use console_governance_adapter_postgres::exception::{
    ExceptionDecision, ExceptionRequest, GovernedWrite, consume_exception_conn,
    decide_exception_conn, get_exception_conn, request_exception_conn,
};
use console_governance_domain::exception::{
    Decision, ExceptionSettings, FallbackKind, RuleCode, SoleHolderMode, SubjectType,
};
use console_identity_adapter_postgres::second_person::{
    SecondPersonQuery, second_person_fact_in_tx,
};
use console_kernel_core::{ErrorKind, KernelError, OrgId, UserId};
use console_onboarding_adapter_postgres::PgOnboardingStore;
use console_onboarding_rest::OnboardingRestState;
use console_ontology_canonical_adapter_postgres::org_unit::{
    OrgUnitCommand, OrgUnitError, OrgUnitQuery, write_in_tx,
};
use console_platform_auth::{
    JwtVerifier, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind,
    PasskeyService,
};
use console_platform_authz::{Feature, Role};
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::{SettingKey, SettingValue};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

struct CanonicalOrgUnitSetupPort;

impl OrgUnitSetupWritePort for CanonicalOrgUnitSetupPort {
    fn write<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        org: OrgId,
        actor: UserId,
        command_id: uuid::Uuid,
        org_unit_id: Option<uuid::Uuid>,
        attributes: serde_json::Value,
    ) -> OrgUnitSetupFuture<'tx> {
        Box::pin(async move {
            let (query, action_key) = match org_unit_id {
                None => (
                    OrgUnitQuery::Create {
                        source: None,
                        attributes,
                    },
                    "internal.setup.create_org_unit",
                ),
                Some(org_unit_id) => (
                    OrgUnitQuery::Revise {
                        org_unit_id,
                        source: None,
                        attributes,
                    },
                    "internal.setup.revise_org_unit",
                ),
            };
            let command = OrgUnitCommand {
                org_id: org,
                command_id: console_ontology_canonical_domain::CommandId::from_uuid(command_id),
                actor_id: actor,
                query,
                action_key: action_key.to_owned(),
                object_type_id: uuid::Uuid::nil(),
            };
            let receipt = write_in_tx(tx, &command)
                .await
                .map_err(|error| match error {
                    OrgUnitError::Blocked(_) | OrgUnitError::DigestConflict(_) => {
                        KernelError::conflict(error.to_string())
                    }
                    OrgUnitError::Database(_) | OrgUnitError::UnreadableReceipt(_, _) => {
                        tracing::error!(error = %error, "org-unit write failed at the setup seam");
                        KernelError::internal("org-unit write failed")
                    }
                })?;
            receipt.result()["org_unit_id"]
                .as_str()
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .ok_or_else(|| KernelError::internal("org-unit receipt names no unit"))
        })
    }

    // --- lane: CRUD ---
    fn org_changes_routed<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        org: OrgId,
    ) -> console_entity_adapter_postgres::RoutedFuture<'tx> {
        Box::pin(async move {
            console_settings_adapter_postgres::approval_routes_in_tx(
                tx.as_mut(),
                org,
                console_settings_domain::SettingKey::ApprovalPolicyOrgStructure,
            )
            .await
        })
    }
}

/// ENT-REG (MR-17): a post-go-live identifier correction consumes the BW-06
/// governed exception for exactly that correction, in the entity adapter's
/// transaction (governance stays the only writer of `governed_exceptions`).
/// Decisions #26 item d: the tenant ops account may record that exception
/// itself, after a step-up (`passkeys`).
struct GovernedIdentifierCorrections {
    pool: PgPool,
    passkeys: Option<PasskeyService>,
}

fn subject_of(subject: CorrectionSubject) -> (SubjectType, uuid::Uuid) {
    match subject {
        CorrectionSubject::LegalEntity(id) => (SubjectType::LegalEntity, id),
        CorrectionSubject::BusinessRegistration(id) => (SubjectType::BusinessRegistration, id),
    }
}

fn step_up_failed() -> KernelError {
    KernelError::forbidden("the passkey step-up did not verify").with_code("passkey_step_up_failed")
}

async fn min_grant_age_days(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, org: OrgId) -> i32 {
    let keys = [SettingKey::AuthzSecondPersonMinGrantAge];
    match resolve_in_tx(
        tx.as_mut(),
        org,
        &keys,
        None,
        time::OffsetDateTime::now_utc(),
    )
    .await
    {
        Ok(resolved) => match resolved.get(&SettingKey::AuthzSecondPersonMinGrantAge) {
            Some(Ok(r)) => match r.value {
                SettingValue::Int(days) => i32::try_from(days).unwrap_or(7),
                _ => 7,
            },
            _ => 7,
        },
        _ => 7,
    }
}

/// The registry values the break-glass exception is admitted under (D0.3);
/// a sole-holder mode other than `step_up_notice_review` refuses (fail closed).
async fn exception_settings(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
) -> Result<ExceptionSettings, KernelError> {
    let keys = [
        SettingKey::ExceptionsApprovalTtlDays,
        SettingKey::AuthzSoleHolderMode,
        SettingKey::ReviewSoleHolderExceptionDue,
    ];
    let resolved = resolve_in_tx(
        tx.as_mut(),
        org,
        &keys,
        None,
        time::OffsetDateTime::now_utc(),
    )
    .await?;
    let value = |key: SettingKey| match resolved.get(&key) {
        Some(Ok(r)) => Ok(r.value),
        _ => Err(KernelError::internal(format!(
            "setting {} did not resolve",
            key.as_str()
        ))),
    };
    let days = |key: SettingKey| match value(key)? {
        SettingValue::Int(days) => u64::try_from(days).map_err(|_| {
            KernelError::internal(format!("setting {} is out of range", key.as_str()))
        }),
        _ => Err(KernelError::internal(format!(
            "setting {} is not a number",
            key.as_str()
        ))),
    };
    Ok(ExceptionSettings {
        approval_ttl_days: u16::try_from(days(SettingKey::ExceptionsApprovalTtlDays)?)
            .map_err(|_| KernelError::internal("exceptions.approval_ttl_days is out of range"))?,
        sole_holder_mode: match value(SettingKey::AuthzSoleHolderMode)? {
            SettingValue::Code("step_up_notice_review") => SoleHolderMode::StepUpNoticeReview,
            _ => SoleHolderMode::Refuse,
        },
        sole_holder_review_due: std::time::Duration::from_secs(
            days(SettingKey::ReviewSoleHolderExceptionDue)? * 86_400,
        ),
    })
}

impl GovernedCorrectionPort for GovernedIdentifierCorrections {
    fn cover_as_ops<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        cover: OpsCover<'tx>,
    ) -> OpsCoverFuture<'tx> {
        let passkeys = self.passkeys.clone();
        let pool = self.pool.clone();
        Box::pin(async move {
            let passkeys = passkeys.ok_or_else(|| {
                KernelError::internal("passkey step-up is not configured").with_code("unavailable")
            })?;
            let (subject_type, subject_id) = subject_of(cover.subject);
            let envelope: MobilePasskeyStepUpEnvelope =
                serde_json::from_value(cover.step_up.clone()).map_err(|_| step_up_failed())?;
            let binding = MobilePasskeyStepUpBinding::bound(
                MobileStepUpActionKind::ExceptionDecide,
                subject_id,
                hex::encode(Sha256::digest(cover.step_up_line.as_bytes())),
            );
            let assertion = passkeys
                .verify_and_record_step_up_in_tx(tx, envelope, cover.actor, &binding)
                .await
                .map_err(|_| step_up_failed())?;
            let settings = exception_settings(tx, cover.org).await?;
            let min_grant_age = min_grant_age_days(tx, cover.org).await;
            let fact = second_person_fact_in_tx(
                tx,
                &SecondPersonQuery {
                    org: cover.org,
                    feature: Feature::OrgChangeApply,
                    branch: None,
                    requester: UserId::from_uuid(cover.actor),
                    excluded: Vec::new(),
                    case_created_at: time::OffsetDateTime::now_utc(),
                    min_grant_age_days: min_grant_age,
                },
            )
            .await?;
            let other_eligible_holders = u64::try_from(fact.other_eligible_holders).unwrap_or(0);
            let request = ExceptionRequest {
                rule: RuleCode::EntityIdentifierCorrection,
                subject_type,
                subject_id,
                reason_code: cover.reason_code,
                note: None,
                payload: cover.payload,
                affected_periods: &[],
                requested_by: UserId::from_uuid(cover.actor),
                step_up_assertion_id: Some(assertion),
                other_eligible_holders,
            };
            if other_eligible_holders > 0 {
                let mut exc_tx = pool.begin().await.map_err(|e| {
                    tracing::error!(error = %e, "failed to begin exception transaction");
                    KernelError::internal("database error")
                })?;
                sqlx::query("SELECT set_config('app.current_org', $1, true)")
                    .bind(cover.org.to_string())
                    .execute(&mut *exc_tx)
                    .await
                    .map_err(|e| {
                        tracing::error!(error = %e, "failed to arm org for exception");
                        KernelError::internal("database error")
                    })?;
                let recorded = request_exception_conn(exc_tx.as_mut(), &request, &settings)
                    .await
                    .map_err(governance_kernel)?;
                exc_tx.commit().await.map_err(|e| {
                    tracing::error!(error = %e, "failed to commit exception transaction");
                    KernelError::internal("database error")
                })?;
                Ok(recorded.id)
            } else {
                let recorded = request_exception_conn(tx.as_mut(), &request, &settings)
                    .await
                    .map_err(governance_kernel)?;
                Ok(recorded.id)
            }
        })
    }

    fn consume<'a>(
        &'a self,
        conn: &'a mut sqlx::PgConnection,
        exception_id: uuid::Uuid,
        subject: CorrectionSubject,
        payload: &'a serde_json::Value,
    ) -> GovernedCorrectionFuture<'a> {
        let kernel = governance_kernel;
        Box::pin(async move {
            let (subject_type, subject_id) = subject_of(subject);
            let write = GovernedWrite {
                rule: RuleCode::EntityIdentifierCorrection,
                subject_type,
                subject_id,
                payload,
                affected_periods: &[],
            };
            consume_exception_conn(conn, exception_id, &write)
                .await
                .map_err(kernel)?;
            let stored = get_exception_conn(conn, exception_id)
                .await
                .map_err(kernel)?;
            Ok(match stored.and_then(|s| s.fallback_kind) {
                Some(FallbackKind::SoleHolder) => CorrectionCover::SoleHolder,
                _ => CorrectionCover::SecondPerson,
            })
        })
    }
}

fn governance_kernel(error: PgGovernanceError) -> KernelError {
    match error {
        PgGovernanceError::Domain(mut k) => {
            if k.code.is_none() {
                k.code = match k.message.as_str() {
                    "exception_not_approved" => Some("exception_not_approved"),
                    "exception_consumed" => Some("exception_consumed"),
                    "exception_expired" => Some("exception_expired"),
                    "exception_not_pending" => Some("exception_not_pending"),
                    "exception_self_decision" => Some("exception_self_decision"),
                    "exception_contributor_decision" => Some("exception_contributor_decision"),
                    "step_up_required" => Some("step_up_required"),
                    "reason_code_invalid" => Some("reason_code_invalid"),
                    _ => None,
                };
            }
            k
        }
        PgGovernanceError::Db(error) => {
            tracing::error!(error = %error, "governed exception write failed at the entity seam");
            KernelError::internal("governed exception write failed")
        }
    }
}

#[derive(Clone)]
struct EntityWiringState {
    pool: PgPool,
    jwt: Option<JwtVerifier>,
    passkeys: Option<PasskeyService>,
}

#[derive(Debug, serde::Deserialize)]
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

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::error!(error = %e, "failed to begin decision transaction");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::json!({"error": {"code": "internal", "message": "database error"}}),
                ),
            )
                .into_response();
        }
    };

    if let Err(e) = sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(principal.org_id.to_string())
        .execute(&mut *tx)
        .await
    {
        tracing::error!(error = %e, "failed to arm org for decision transaction");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": {"code": "internal", "message": "database error"}})),
        )
            .into_response();
    }

    let step_up_assertion_id = if let Some(step_up_val) = body.step_up {
        let Some(passkeys) = state.passkeys.as_ref() else {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": {"code": "unavailable", "message": "passkeys unavailable"}})),
            ).into_response();
        };
        let envelope: MobilePasskeyStepUpEnvelope = match serde_json::from_value(step_up_val) {
            Ok(env) => env,
            Err(_) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": {"code": "step_up_required", "message": "step_up_required"}})),
                ).into_response();
            }
        };
        let binding = envelope.binding.clone();
        match passkeys
            .verify_and_record_step_up_in_tx(
                &mut tx,
                envelope,
                *principal.user_id.as_uuid(),
                &binding,
            )
            .await
        {
            Ok(assertion) => Some(assertion),
            Err(e) => {
                tracing::warn!(error = %e, "step-up verification refused");
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": {"code": "step_up_required", "message": "step_up_required"}})),
                ).into_response();
            }
        }
    } else {
        None
    };

    let holds_permission = principal
        .roles
        .iter()
        .any(|r| *r == Role::SuperAdmin || *r == Role::Executive);
    let input = ExceptionDecision {
        decision,
        decider: &principal,
        contributed: false,
        holds_permission,
        step_up_assertion_id,
        reason_code: &body.reason_code,
        note: body.note.as_deref(),
    };

    let status = match decide_exception_conn(tx.as_mut(), id, &input).await {
        Ok(status) => status,
        Err(e) => {
            let kernel_err = governance_kernel(e);
            let status = match kernel_err.kind {
                ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
                ErrorKind::NotFound => StatusCode::NOT_FOUND,
                ErrorKind::Forbidden => StatusCode::FORBIDDEN,
                ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
                ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            };
            let code = kernel_err.code.unwrap_or(kernel_err.message.as_str());
            return (
                status,
                Json(serde_json::json!({
                    "error": {
                        "code": code,
                        "message": kernel_err.message,
                    }
                })),
            )
                .into_response();
        }
    };

    if let Err(e) = tx.commit().await {
        tracing::error!(error = %e, "failed to commit decision transaction");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": {"code": "internal", "message": "database error"}})),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "id": id,
            "status": status.as_db_str(),
        })),
    )
        .into_response()
}

/// The canonical OrgUnit seam, for the lifecycle tick's 사업장 close step (UX-R2 ENDS).
pub(crate) fn org_unit_port() -> Arc<dyn OrgUnitSetupWritePort> {
    Arc::new(CanonicalOrgUnitSetupPort)
}

/// Both faces, ready to merge into the application router.
pub(crate) fn router(
    pool: PgPool,
    jwt: Option<JwtVerifier>,
    passkey: Option<PasskeyService>,
    juso: Arc<JusoClient>,
) -> Router {
    let wiring_state = EntityWiringState {
        pool: pool.clone(),
        jwt: jwt.clone(),
        passkeys: passkey.clone(),
    };
    let entity = console_entity_rest::router(
        EntityRestState::new(
            PgEntityStore::new(pool.clone()),
            jwt.clone(),
            Some(Arc::new(CanonicalOrgUnitSetupPort)),
        )
        .with_juso(juso)
        .with_governed_corrections(Arc::new(GovernedIdentifierCorrections {
            pool: pool.clone(),
            passkeys: passkey.clone(),
        })),
    );
    let onboarding = console_onboarding_rest::router(OnboardingRestState::new(
        PgOnboardingStore::new(pool),
        jwt,
        passkey,
    ));
    let exceptions = Router::new()
        .route("/api/v1/exceptions/{id}/decide", post(decide_exception))
        .route(
            "/api/v1/governed-exceptions/{id}/decide",
            post(decide_exception),
        )
        .with_state(wiring_state);
    entity.merge(onboarding).merge(exceptions)
}
