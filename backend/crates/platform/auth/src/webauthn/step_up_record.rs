//! BW-29: verify a step-up for a governed act and record it in
//! `step_up_assertions` (migration 0254). The record is what every
//! `step_up_assertion_id` points at: its value is the consumed ceremony id.

use uuid::Uuid;

use super::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobilePasskeyStepUpVerificationError,
    PasskeyService, load_mobile_step_up_binding_tx, lock_assertion_account_tx, lock_ceremony_tx,
};
use crate::AuthError;

impl PasskeyService {
    /// Verify `envelope` for `expected_binding`, a BW-29 kind bound to the
    /// server-recomputed payload hash, inside the caller's decision transaction,
    /// and record it. Single-use and fresh within the ceremony TTL like every
    /// assertion, with user verification and a credential of `expected_user_id`.
    /// Returns the ceremony id, the act's `step_up_assertion_id`.
    ///
    /// # Errors
    ///
    /// A legacy kind, a binding that differs from the expected or the persisted
    /// one, a foreign ceremony or credential, or a failed assertion.
    pub async fn verify_and_record_step_up_in_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        envelope: MobilePasskeyStepUpEnvelope,
        expected_user_id: Uuid,
        expected_binding: &MobilePasskeyStepUpBinding,
    ) -> Result<Uuid, MobilePasskeyStepUpVerificationError> {
        if expected_binding.action_kind.is_legacy()
            || expected_binding.validate().is_err()
            || envelope.binding != *expected_binding
        {
            return Err(MobilePasskeyStepUpVerificationError::BindingMismatch);
        }
        let ceremony_id = envelope.assertion.ceremony_id;
        let locator = lock_assertion_account_tx(tx, &envelope.assertion.credential).await?;
        let claim = lock_ceremony_tx(tx, ceremony_id, "authentication").await?;
        if claim.user_id != Some(expected_user_id) {
            return Err(AuthError::InvalidStoredData(
                "step-up ceremony does not belong to the authenticated user".to_owned(),
            )
            .into());
        }
        let persisted = load_mobile_step_up_binding_tx(tx, ceremony_id).await?;
        if persisted.as_ref() != Some(expected_binding) {
            return Err(MobilePasskeyStepUpVerificationError::BindingMismatch);
        }
        let outcome = self
            .verify_assertion_in_tx(
                tx,
                ceremony_id,
                claim,
                locator,
                envelope.assertion.credential,
                Some(expected_user_id),
            )
            .await?;
        sqlx::query(
            r#"
            INSERT INTO step_up_assertions (
                ceremony_id, org_id, user_id, credential_row_id, action_kind, object_id,
                payload_hash, user_verified
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
            "#,
        )
        .bind(ceremony_id)
        .bind(*outcome.org_id.as_uuid())
        .bind(outcome.user_id)
        .bind(outcome.passkey_id)
        .bind(expected_binding.action_kind.as_wire())
        .bind(expected_binding.object_id)
        .bind(&expected_binding.payload_hash)
        .execute(tx.as_mut())
        .await?;
        Ok(ceremony_id)
    }
}
