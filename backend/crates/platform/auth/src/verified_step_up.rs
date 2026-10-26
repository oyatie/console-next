// SPDX-License-Identifier: LicenseRef-Proprietary
//! A verifier-issued proof carried into an identity-binding transaction.

use sqlx::PgPool;
use uuid::Uuid;

use crate::{AuthError, PasskeyAuthenticationCredential, PasskeyService};

// shortcut: possession-only proof; bind the account-link payload in slice 2.
/// An assertion of this account's own passkey, with user verification required.
/// Only the verifier can construct it; consuming it identifies the command actor.
///
/// ```compile_fail
/// use console_platform_auth::VerifiedStepUp;
/// let proof = VerifiedStepUp { user_id: uuid::Uuid::new_v4() };
/// ```
#[derive(Debug)]
pub struct VerifiedStepUp {
    user_id: Uuid,
}

impl VerifiedStepUp {
    #[must_use]
    pub fn into_user_id(self) -> Uuid {
        self.user_id
    }
}

impl PasskeyService {
    /// Return a proof only after the existing single-use step-up verifier succeeds.
    ///
    /// # Errors
    /// The same ceremony, credential, account and storage failures as the verifier.
    pub async fn verify_step_up_proof_for_user(
        &self,
        pool: &PgPool,
        ceremony_id: Uuid,
        credential: PasskeyAuthenticationCredential,
        expected_user_id: Uuid,
    ) -> Result<VerifiedStepUp, AuthError> {
        self.verify_step_up_for_user(pool, ceremony_id, credential, expected_user_id)
            .await?;
        Ok(VerifiedStepUp {
            user_id: expected_user_id,
        })
    }
}
