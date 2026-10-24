//! `PlatformRestState`'s optional capabilities, installed by the App tier.
//! Split from `lib.rs` (file-size ratchet); state and capability builders share this module.

use console_platform_auth::{JwtIssuer, JwtVerifier, PasskeyService};
use console_platform_provisioning::PlatformProvisioner;
use sqlx::PgPool;

use crate::TenantConfigSeeder;

/// Produces the ops screen's operator notices (JSON objects) on each read.
pub type OpsNotices = std::sync::Arc<dyn Fn() -> Vec<serde_json::Value> + Send + Sync>;

#[derive(Clone)]
pub struct PlatformRestState {
    pub(crate) pool: PgPool,
    /// Destructive tenant removal is executed only through this isolated
    /// capability pool; `pool` remains the general runtime/read path.
    pub(crate) force_remove_command_pool: Option<PgPool>,
    pub(crate) jwt_verifier: Option<JwtVerifier>,
    /// Issuer for tenant-approved, read-only support sessions.
    /// `None` refuses START, so token issuance is opt-in.
    pub(crate) support_issuer: Option<JwtIssuer>,
    pub(crate) provisioner: PlatformProvisioner,
    /// Engine-backed catalog seeder run once per new tenant on onboarding. `None`
    /// leaves onboarding to create only the shell (org + admin + OTP).
    pub(crate) tenant_config_seeder: Option<TenantConfigSeeder>,
    /// Verifies the operator's fresh passkey assertion on writes that mint
    /// sign-in material for someone else. `None` makes those writes 503.
    pub(crate) passkey_step_up: Option<PasskeyService>,
    /// Operator notices for the vendor ops screen (e.g. an address-search key
    /// about to expire), supplied by the App tier. Never on a tenant surface.
    pub(crate) ops_notices: Option<OpsNotices>,
    pub(crate) registration_check_notices: Option<OpsNotices>,
}

impl PlatformRestState {
    #[must_use]
    pub fn new(
        pool: PgPool,
        jwt_verifier: Option<JwtVerifier>,
        provisioner: PlatformProvisioner,
    ) -> Self {
        Self {
            pool,
            force_remove_command_pool: None,
            jwt_verifier,
            support_issuer: None,
            provisioner,
            tenant_config_seeder: None,
            passkey_step_up: None,
            ops_notices: None,
            registration_check_notices: None,
        }
    }
}

impl PlatformRestState {
    /// Install the operator-notice source shown on `GET /api/platform/ops`.
    #[must_use]
    pub fn with_ops_notices(mut self, notices: OpsNotices) -> Self {
        self.ops_notices = Some(notices);
        self
    }

    /// Authority-key notices use an additive field so N-1 notice enums remain valid.
    #[must_use]
    pub fn with_registration_check_notices(mut self, notices: OpsNotices) -> Self {
        self.registration_check_notices = Some(notices);
        self
    }

    /// Install the WebAuthn verifier for step-up-gated platform writes.
    #[must_use]
    pub fn with_passkey_step_up(mut self, passkey_step_up: Option<PasskeyService>) -> Self {
        self.passkey_step_up = passkey_step_up;
        self
    }

    /// Install the dedicated database identity allowed to execute the destructive
    /// platform force-removal function. `None` makes that endpoint fail closed.
    #[must_use]
    pub fn with_force_remove_command_pool(mut self, pool: Option<PgPool>) -> Self {
        self.force_remove_command_pool = pool;
        self
    }

    /// Install the engine-backed governed-config catalog seeder run for each newly
    /// onboarded tenant. Supplied by the App tier so the platform tier stays free
    /// of an ontology-adapter dependency.
    #[must_use]
    pub fn with_tenant_config_seeder(mut self, seeder: Option<TenantConfigSeeder>) -> Self {
        self.tenant_config_seeder = seeder;
        self
    }

    /// Install the JWT issuer used by platform START paths that mint tenant
    /// context tokens. Without it START endpoints return 503; EXIT and the
    /// read-only gate do not need an issuer.
    #[must_use]
    pub fn with_support_issuer(mut self, issuer: Option<JwtIssuer>) -> Self {
        self.support_issuer = issuer;
        self
    }
}
