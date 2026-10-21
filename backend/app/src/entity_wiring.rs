//! Composition for the 법인 · 사업장 (`console-entity-rest`) and setup-phase
//! (`console-onboarding-rest`) faces, kept out of `lib.rs` (R1) so the
//! router merge there is one line.
//!
//! The one seam that needs the composition root: setup-phase org units are
//! written by the canonical OrgUnit owner (`org_unit::write_in_tx`), inside
//! the entity adapter's transaction — one writer, one more caller, the same
//! shape as the org-change apply seam (`PgOrgUnitWritePort` in lib.rs).

use std::sync::Arc;

use axum::Router;
use console_entity_adapter_juso::JusoClient;
use console_entity_adapter_postgres::{
    CorrectionCover, CorrectionSubject, GovernedCorrectionFuture, GovernedCorrectionPort, OpsCover,
    OpsCoverFuture, OrgUnitSetupFuture, OrgUnitSetupWritePort, PgEntityStore,
};
use console_entity_rest::EntityRestState;
use console_governance_adapter_postgres::PgGovernanceError;
use console_governance_adapter_postgres::exception::{
    ExceptionRequest, GovernedWrite, consume_exception_conn, get_exception_conn,
    request_exception_conn,
};
use console_governance_domain::exception::{
    ExceptionSettings, FallbackKind, RuleCode, SoleHolderMode, SubjectType,
};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_onboarding_adapter_postgres::PgOnboardingStore;
use console_onboarding_rest::OnboardingRestState;
use console_ontology_canonical_adapter_postgres::org_unit::{
    OrgUnitCommand, OrgUnitError, OrgUnitQuery, write_in_tx,
};
use console_platform_auth::{
    JwtVerifier, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind,
    PasskeyService,
};
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
            // Break-glass covers the act alone: recorded as the sole-holder
            // fallback, so it carries the 사후 검토 due date and notice.
            let recorded = request_exception_conn(
                tx.as_mut(),
                &ExceptionRequest {
                    rule: RuleCode::EntityIdentifierCorrection,
                    subject_type,
                    subject_id,
                    reason_code: cover.reason_code,
                    note: None,
                    payload: cover.payload,
                    affected_periods: &[],
                    requested_by: UserId::from_uuid(cover.actor),
                    step_up_assertion_id: Some(assertion),
                    other_eligible_holders: 0,
                },
                &settings,
            )
            .await
            .map_err(governance_kernel)?;
            Ok(recorded.id)
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
        PgGovernanceError::Domain(k) => k,
        PgGovernanceError::Db(error) => {
            tracing::error!(error = %error, "governed exception write failed at the entity seam");
            KernelError::internal("governed exception write failed")
        }
    }
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
    let entity = console_entity_rest::router(
        EntityRestState::new(
            PgEntityStore::new(pool.clone()),
            jwt.clone(),
            Some(Arc::new(CanonicalOrgUnitSetupPort)),
        )
        .with_juso(juso)
        .with_governed_corrections(Arc::new(GovernedIdentifierCorrections {
            passkeys: passkey.clone(),
        })),
    );
    let onboarding = console_onboarding_rest::router(OnboardingRestState::new(
        PgOnboardingStore::new(pool),
        jwt,
        passkey,
    ));
    entity.merge(onboarding)
}
