// SPDX-License-Identifier: LicenseRef-Proprietary
use console_compliance_adapter_postgres::PgComplianceStore;
use console_platform_auth::JwtVerifier;

#[derive(Clone)]
pub struct ComplianceRestState {
    pub(super) store: PgComplianceStore,
    pub(super) jwt_verifier: Option<JwtVerifier>,
}

impl ComplianceRestState {
    #[must_use]
    pub fn new(store: PgComplianceStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}
