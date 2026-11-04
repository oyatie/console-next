// SPDX-License-Identifier: LicenseRef-Proprietary
use console_compliance_adapter_postgres::PgComplianceStore;
use console_platform_auth::JwtVerifier;

#[derive(Clone)]
pub struct ComplianceRestState {
    pub(super) store: PgComplianceStore,
    pub(super) passkey_step_up: Option<console_platform_auth::PasskeyService>,
    pub(super) jwt_verifier: Option<JwtVerifier>,
}

impl ComplianceRestState {
    #[must_use]
    pub fn with_passkey_step_up(
        mut self,
        service: Option<console_platform_auth::PasskeyService>,
    ) -> Self {
        self.passkey_step_up = service;
        self
    }
    #[must_use]
    pub fn new(store: PgComplianceStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            passkey_step_up: None,
            jwt_verifier,
        }
    }
}
