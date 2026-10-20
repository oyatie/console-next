//! Governed identifier corrections share the entity transaction with their verified assertion.
use console_entity_adapter_postgres::{
    CorrectionCover, CorrectionSubject, GovernedCorrectionFuture, GovernedCorrectionPort, OpsCover,
    OpsCoverFuture, RequestedCorrection,
};
use console_governance_adapter_postgres::{
    PgGovernanceError,
    exception::{
        ExceptionRequest, GovernedWrite, consume_exception_conn, get_exception_conn,
        request_exception_conn,
    },
};
use console_governance_domain::exception::{
    ExceptionSettings, FallbackKind, RuleCode, SoleHolderMode, SubjectType,
};
use console_identity_adapter_postgres::second_person::{
    SecondPersonQuery, second_person_fact_in_tx,
};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind, PasskeyService,
};
use console_platform_authz::Feature;
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::{SettingKey, SettingValue};
use sha2::{Digest, Sha256};
/// ENT-REG (MR-17): a post-go-live identifier correction consumes the BW-06
/// governed exception for exactly that correction, in the entity adapter's
/// transaction (governance stays the only writer of `governed_exceptions`).
/// Decisions #26 item d: the tenant ops account may record that exception
/// itself, after a step-up (`passkeys`).
pub(super) struct GovernedIdentifierCorrections {
    pub(super) passkeys: Option<PasskeyService>,
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
            let excluded = correction_contributors(tx, subject_type, subject_id).await?;
            let fact = second_person_fact_in_tx(
                tx,
                &SecondPersonQuery {
                    org: cover.org,
                    feature: Feature::OrgChangeApply,
                    branch: None,
                    requester: UserId::from_uuid(cover.actor),
                    excluded,
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
            let recorded = request_exception_conn(tx.as_mut(), &request, &settings)
                .await
                .map_err(governance_kernel)?;
            Ok(
                if recorded.admission.status
                    == console_governance_domain::exception::ExceptionStatus::Pending
                {
                    RequestedCorrection::Pending(recorded.id)
                } else {
                    RequestedCorrection::Covered(recorded.id)
                },
            )
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

pub(super) fn governance_kernel(error: PgGovernanceError) -> KernelError {
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
                    "exception_not_found" => Some("exception_not_found"),
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

pub(super) async fn correction_contributors(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    subject_type: SubjectType,
    subject_id: uuid::Uuid,
) -> Result<Vec<UserId>, KernelError> {
    let sql = match subject_type {
        SubjectType::LegalEntity => {
            "SELECT created_by AS actor FROM legal_entities WHERE id=$1 UNION SELECT actor_id FROM legal_entity_revisions WHERE legal_entity_id=$1 UNION SELECT actor_id FROM entity_identifier_corrections WHERE legal_entity_id=$1 AND registration_id IS NULL"
        }
        SubjectType::BusinessRegistration => {
            "SELECT created_by AS actor FROM business_registrations WHERE id=$1 UNION SELECT actor_id FROM business_registration_revisions WHERE registration_id=$1 UNION SELECT actor_id FROM entity_identifier_corrections WHERE registration_id=$1"
        }
        _ => return Err(KernelError::forbidden("exception_subject_unsupported")),
    };
    let ids: Vec<Option<uuid::Uuid>> = sqlx::query_scalar(sql)
        .bind(subject_id)
        .fetch_all(tx.as_mut())
        .await
        .map_err(|_| KernelError::internal("failed to resolve correction contributors"))?;
    Ok(ids.into_iter().flatten().map(UserId::from_uuid).collect())
}
