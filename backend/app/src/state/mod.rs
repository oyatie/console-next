//! `AppState`: the shared dependencies every router and worker is built from.

pub(crate) mod build;
pub(crate) mod db;
#[cfg(any(feature = "dispatch", feature = "support", feature = "mail"))]
mod modules;
mod support;

use crate::config::AppConfig;
#[cfg(feature = "mail")]
use crate::mail_sync;
#[cfg(feature = "mail")]
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_platform_audit_chain::SealSigner;
use console_platform_auth::{JwtIssuer, JwtVerifier, PasskeyService};
use console_platform_auth_rest::AuthRestState;
use console_platform_email::EmailSender;
#[cfg(any(feature = "dispatch", feature = "workorder"))]
use console_platform_jobs::JobQueue;
#[cfg(any(feature = "dispatch", feature = "support"))]
use console_platform_push::PushNotifier;
use console_platform_realtime::{PgRealtimeHub, PostgresBridgeHandle};
use console_platform_storage::{EvidenceService, SeaweedS3Storage};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum DatabaseDependency {
    NotConfigured,
    Postgres(PgPool),
}

#[derive(Clone)]
pub struct AppState {
    pub(crate) config: AppConfig,
    pub(crate) web_release: Arc<str>,
    pub(crate) support_log_client: reqwest::Client,
    pub(crate) database: DatabaseDependency,
    /// Narrow command pool for leave mutations. It is intentionally separate
    /// from the general runtime pool so PostgreSQL grants remain the final,
    /// non-bypassable authority boundary even if an API handler is compromised.
    pub(crate) leave_command_database: DatabaseDependency,
    /// Narrow command pool for ontology schema mutations and canonical seeding.
    pub(crate) ontology_command_database: DatabaseDependency,
    /// Dedicated command pool for platform tenant force removal. It is never
    /// substituted with the tenant-scoped runtime pool.
    pub(crate) platform_force_command_database: DatabaseDependency,
    /// Migration-identity connection for fixed, test-only E2E terms fixtures.
    #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
    pub(crate) e2e_fixture_database: DatabaseDependency,
    pub(crate) jwt_verifier: Option<JwtVerifier>,
    /// JWT issuer used ONLY by the PLATFORM view-as START path to mint
    /// short-lived read-only impersonation tokens. Built from the same ES256
    /// keypair as the auth-rest issuer (so view-as tokens verify with the live
    /// `jwt_verifier`). `None` when no private key is configured — the view-as
    /// START endpoint then returns 503.
    pub(crate) view_as_issuer: Option<JwtIssuer>,
    /// Fresh passkey step-up verifier for sensitive policy-authoring actions.
    /// Built from the auth-rest WebAuthn RP settings; if auth-rest is disabled,
    /// policy lifecycle changes fail closed instead of accepting bearer-only
    /// publish/rollback requests.
    pub(crate) policy_step_up: Option<PasskeyService>,
    pub(crate) auth_rest: Option<AuthRestState>,
    pub(crate) evidence_storage: Option<EvidenceService<SeaweedS3Storage>>,
    /// Object store + bucket backing the public storefront media-serve route.
    pub(crate) sales_media_storage: Option<(SeaweedS3Storage, String)>,
    /// WORM object store + replica (compliance-locked) bucket the evidence
    /// fixity check HEADs. `None` when object storage is unconfigured — the
    /// evidence `verify` endpoint then 503s rather than green-lighting an
    /// unverifiable object.
    #[cfg(feature = "docs")]
    pub(crate) worm_evidence_storage: Option<(SeaweedS3Storage, String)>,
    #[cfg(any(feature = "dispatch", feature = "workorder"))]
    pub(crate) dispatch_job_queue: Option<Arc<dyn JobQueue>>,
    #[cfg(any(feature = "dispatch", feature = "support"))]
    pub(crate) push_notifier: Option<Arc<dyn PushNotifier>>,
    /// Outbound email sender for the open-signup OTP (#38). Always present: a
    /// `LettreSmtpSender` when live SMTP is configured, an explicitly-enabled
    /// non-prod `StubEmailSender` when `CONSOLE_EMAIL_STUB_MODE` is set, otherwise a
    /// fail-closed sender that never logs OTPs.
    pub(crate) email_sender: Arc<dyn EmailSender>,
    pub(crate) realtime_hub: Option<Arc<PgRealtimeHub>>,
    pub(crate) realtime_bridge: Option<PostgresBridgeHandle>,
    /// The webmail master-key cipher (envelope AEAD for SMTP/IMAP credentials).
    /// `None` when `CONSOLE_MAIL_MASTER_KEY` is absent at boot — the app STILL boots
    /// and the mail router still mounts. Read-only mail endpoints degrade to a
    /// clean no-account/empty state; credential-using endpoints return a clear
    /// `503 email_not_configured`. The cipher feature is lazily/optionally init'd
    /// so a missing key is never a panic.
    #[cfg(feature = "mail")]
    pub(crate) mail_cipher: Option<Arc<EnvelopeCredentialCipher>>,
    /// The inbound webmail IMAP sync worker handle. `None` when the worker is OFF
    /// (no KEK / no storage / `CONSOLE_MAIL_ENABLED` unset). Held so its lifetime is
    /// tied to the running `AppState` and it stops on shutdown.
    #[cfg(feature = "mail")]
    pub(crate) mail_sync_handle: Option<Arc<mail_sync::MailSyncHandle>>,
    /// Shared verifier for the read-only audit-chain attestation endpoint.
    /// When [`AppConfig::audit_chain_external`] is set this is an
    /// `ExternalSealSigner` (pinned anchors); otherwise an in-memory dev
    /// verifier that is **not** a trust root.
    pub(crate) audit_attestation_signer: Arc<dyn SealSigner>,
    /// The juso proxies' client, shared by the entity face and the ops notices.
    pub(crate) juso: Arc<console_entity_adapter_juso::JusoClient>,
    /// BG-8: set on SIGTERM; `/readyz` answers 503 from then on.
    pub(crate) draining: Arc<std::sync::atomic::AtomicBool>,
}
