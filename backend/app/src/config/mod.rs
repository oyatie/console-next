//! 12-factor process configuration: `AppConfig` and its defaults, parsed from the environment.

pub(crate) mod auth;
pub(crate) mod database;
pub(crate) mod db_pool;
pub(crate) mod dispatch;
pub(crate) mod email;
pub(crate) mod env;
pub(crate) mod links;
pub(crate) mod notify;
pub(crate) mod office;
pub(crate) mod parse;
pub(crate) mod proxy;
pub(crate) mod role;
pub(crate) mod secret_files;
pub(crate) mod storage;

use crate::audit_chain_signer;
use crate::config::auth::JwtVerifierConfig;
use crate::config::role::AppRole;
use console_dispatch_domain::DispatchTimerConfig;
use console_kernel_core::OrgId;
use console_platform_auth_rest::AuthRestConfig;
use console_platform_email::{SmtpEmailConfig, StubEmailMode};
use console_platform_push::{FcmConfig, SolapiConfig};
use console_platform_storage::S3StorageConfig;
use ipnet::IpNet;
use std::net::SocketAddr;
use std::time::Duration;

pub(crate) const DEFAULT_HTTP_ADDR: &str = "0.0.0.0:8080";
pub(crate) const DEFAULT_SERVICE_NAME: &str = "console-app";
pub(crate) const DEFAULT_SHUTDOWN_TIMEOUT_SECS: u64 = 10;
// These role-backed defaults are an operational correctness backstop for every
// serving pool. They limit accidental/buggy work; they are not a security
// boundary against a caller that has already compromised a database credential.
pub(crate) const SERVING_STATEMENT_TIMEOUT: &str = "30s";
pub(crate) const SERVING_IDLE_IN_TRANSACTION_SESSION_TIMEOUT: &str = "30s";
pub(crate) const SERVING_TRANSACTION_TIMEOUT: &str = "45s";
pub(crate) const DEFAULT_EVIDENCE_TRANSCODE_CONCURRENCY: usize = 2;
pub(crate) const DEFAULT_JWT_ISSUER: &str = "console-platform-auth";
pub(crate) const DEFAULT_JWT_AUDIENCE: &str = "console-api";
pub(crate) const DEFAULT_WEBAUTHN_RP_NAME: &str = "Console";
pub(crate) const DEFAULT_AUTH_CEREMONY_TTL_SECS: u64 = 300;
pub(crate) const DEFAULT_REFRESH_TOKEN_TTL_SECS: u64 = 60 * 60 * 24 * 30;
/// Absolute refresh-family lifetime cap (NIST 800-63B AAL2). Default 24h: past
/// this the family is revoked on rotation and a fresh primary auth is required.
pub(crate) const DEFAULT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS: u64 = 60 * 60 * 24;
pub(crate) const DEFAULT_COLDSTART_OTP_TTL_SECS: u64 = 3600;
pub(crate) const DEFAULT_DISPATCH_ACCEPT_WINDOW_SECS: u64 = 5 * 60;
pub(crate) const DEFAULT_DISPATCH_FORCE_ASSIGN_ALERT_SECS: u64 = 10 * 60;
pub(crate) const DEFAULT_DISPATCH_ALIMTALK_NO_ACK_SECS: u64 = 2 * 60;
pub(crate) const DEFAULT_DISPATCH_GPS_FRESHNESS_SECS: u64 = 15 * 60;
pub(crate) const DEFAULT_FCM_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
pub(crate) const DEFAULT_FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
pub(crate) const DEFAULT_SOLAPI_BASE_URL: &str = "https://api.solapi.com";
pub(crate) const EMAIL_STUB_MODE_ENV: &str = "CONSOLE_EMAIL_STUB_MODE";

/// Default per-request timeout; sheds requests that hang on a slow upstream or
/// DB so a stuck handler cannot pin a connection indefinitely. Overridable via
/// `CONSOLE_REQUEST_TIMEOUT_SECS` (see `AppConfig::request_timeout`).
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub role: AppRole,
    pub service_name: String,
    pub http_addr: SocketAddr,
    /// P4: `/metrics` (+ `/healthz`, `/readyz`) on this listener only, never
    /// on the public one. `None`: `/metrics` stays on `http_addr`.
    pub internal_addr: Option<SocketAddr>,
    /// B-15: release toggles on for this deployment (`CONSOLE_RELEASE_TOGGLES`).
    pub release_toggles: Vec<String>,
    pub database_url: Option<String>,
    /// Dedicated least-privilege connection used only for leave commands
    /// (`LEAVE_COMMAND_DATABASE_URL`). The API requires this whenever its
    /// general runtime `DATABASE_URL` is configured so command execution can
    /// never silently fall back to the broader `console_rt` credential. Worker and
    /// migrate roles do not open or require this pool.
    pub leave_command_database_url: Option<String>,
    /// Dedicated least-privilege connection for ontology schema commands
    /// (`ONTOLOGY_COMMAND_DATABASE_URL`). Like the leave command credential,
    /// this is API-only and never falls back to `console_rt` in a configured
    /// deployment.
    pub ontology_command_database_url: Option<String>,
    /// Dedicated least-privilege connection for destructive platform tenant
    /// removal (`PLATFORM_FORCE_COMMAND_DATABASE_URL`). This API-only pool is
    /// required whenever the runtime database is configured; it never falls
    /// back to `console_rt`.
    pub platform_force_command_database_url: Option<String>,
    pub otlp_endpoint: Option<String>,
    /// Server-only VictoriaLogs /select/logsql/query URL for Cedar-gated diagnostics.
    pub support_log_query_url: Option<String>,
    pub jwt: Option<JwtVerifierConfig>,
    pub auth_rest: Option<AuthRestConfig>,
    pub storage: Option<S3StorageConfig>,
    /// 도로명주소 / 상세주소 search keys and knobs (STREET_JUSO_API_KEY, …).
    pub juso: console_entity_adapter_juso::JusoConfig,
    pub nts: console_entity_adapter_nts::NtsConfig,
    pub dispatch_timers: DispatchTimerConfig,
    pub dispatch_jobs_enabled: bool,
    /// Max concurrent evidence transcodes the worker runs at once
    /// (`CONSOLE_EVIDENCE_TRANSCODE_CONCURRENCY`, default 2). Backpressure cap so a
    /// burst of mechanic uploads can't exhaust the worker's CPU/disk.
    pub evidence_transcode_concurrency: usize,
    pub fcm: Option<FcmConfig>,
    pub solapi: Option<SolapiConfig>,
    pub solapi_disabled_reason: Option<String>,
    /// Outbound SMTP relay for transactional email (open-signup OTP). `Some`
    /// only when the live `CONSOLE_EMAIL_*` SMTP group is complete and valid.
    pub email: Option<SmtpEmailConfig>,
    /// Explicit non-production mode that allows `StubEmailSender` to log OTPs
    /// instead of sending mail (`CONSOLE_EMAIL_STUB_MODE=local|dev|development|test|e2e`).
    /// `None` means missing SMTP fails closed at send time and partial SMTP
    /// configuration fails during config parsing.
    pub email_stub_mode: Option<StubEmailMode>,
    /// Test-only platform publisher connection for immutable E2E terms fixtures.
    #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
    pub e2e_fixture_database_url: Option<String>,
    pub shutdown_timeout: Duration,
    /// Per-request timeout applied to every non-streaming route
    /// (`CONSOLE_REQUEST_TIMEOUT_SECS`, default 30s). Deliberately NOT applied to
    /// the long-lived realtime WS route, which is merged outside this layer.
    /// Configurable primarily so tests can prove the realtime route escapes the
    /// timeout without waiting the full production budget.
    pub request_timeout: Duration,
    /// Each process's database pools: the `db.pool.*` registry keys, with any
    /// `CONSOLE_DB_POOL_*` override (decisions #28).
    pub db_pool: db_pool::DbPoolConfig,
    /// Deploy-time cold-start OTP for the cold-start SUPER_ADMIN, supplied
    /// out-of-band via `CONSOLE_COLDSTART_OTP`. `None` (or empty) means no
    /// cold-start OTP is seeded at boot â the normal state once an admin exists.
    pub coldstart_otp: Option<String>,
    /// Lifetime of a boot-seeded cold-start OTP (`CONSOLE_COLDSTART_OTP_TTL_SECS`,
    /// default 3600s).
    pub coldstart_otp_ttl: time::Duration,
    /// Number of configured reverse-proxy hops in front of the service,
    /// including the direct transport peer (`CONSOLE_TRUSTED_PROXY_COUNT`, default
    /// 0). Forwarding headers are ignored unless every configured hop is in
    /// [`Self::trusted_proxy_cidrs`].
    pub trusted_proxy_count: usize,
    /// CIDRs allowed to present forwarding headers at process ingress
    /// (`CONSOLE_TRUSTED_PROXY_CIDRS`, comma-separated). Required when the hop
    /// count is nonzero.
    pub trusted_proxy_cidrs: Vec<IpNet>,
    /// Native app-link association metadata served at `/.well-known/*`. Drives
    /// the public, unauthenticated Apple App Site Association + Android asset
    /// links documents that authorize the native apps' passkeys for the RP
    /// domain. Sourced from `CONSOLE_IOS_APP_IDS`, `CONSOLE_ANDROID_PACKAGE`, and
    /// `CONSOLE_ANDROID_CERT_SHA256` (see [`app_links_config_from_vars`]).
    pub app_links: AppLinksConfig,
    /// Whether the inbound webmail IMAP sync worker runs (`CONSOLE_MAIL_ENABLED`,
    /// default false). Even when true the worker only starts if the master KEK
    /// (`CONSOLE_MAIL_MASTER_KEY`) and object storage are both configured — it is a
    /// no-op otherwise, so a misconfiguration never crashes the app.
    pub mail_enabled: bool,
    /// Mox webapi base URL for outbound webmail transport
    /// (`CONSOLE_MAIL_MOX_BASE_URL`). `None` keeps the default SMTP/lettre path.
    pub mail_mox_base_url: Option<String>,
    /// Shared secret for the inbound Mox delivery webhook
    /// (`CONSOLE_MAIL_MOX_WEBHOOK_SECRET`). `None` leaves the webhook mounted but
    /// unavailable with 503 rather than accepting unauthenticated deliveries.
    pub mail_mox_webhook_secret: Option<String>,
    /// Whether the L20 tamper-evident audit-chain seal worker runs
    /// (`CONSOLE_AUDIT_CHAIN_SEAL_ENABLED`, default false). When true, the
    /// worker requires [`Self::audit_chain_external`] (pinned anchors + custody
    /// URL) unless [`Self::audit_chain_allow_dev_signer`] is explicitly set —
    /// enabling sealing without custody fails closed (worker does not start).
    /// Default OFF so a misconfigured deploy never writes throwaway-keyed seals.
    /// The attestation REST endpoint reads whatever is sealed regardless of
    /// this flag.
    pub audit_chain_seal_enabled: bool,
    /// Production external seal config: active `key_ref`, locally pinned trust
    /// anchors, and HTTP custody URL (`CONSOLE_AUDIT_CHAIN_SEAL_KEY_REF` +
    /// `CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS` + `CONSOLE_AUDIT_CHAIN_CUSTODY_URL`).
    /// `None` keeps attestation on the in-memory dev verifier (non-evidentiary).
    pub audit_chain_external: Option<audit_chain_signer::AuditChainExternalConfig>,
    /// Explicit escape hatch (`CONSOLE_AUDIT_CHAIN_ALLOW_DEV_SIGNER`, default
    /// false) that lets the seal worker use `InMemoryEd25519Signer` when
    /// external custody is unset. Never set in production — seals under
    /// `test:ed25519:<hex>` are not tamper evidence.
    pub audit_chain_allow_dev_signer: bool,
    /// The tenant that owns the PUBLIC storefront/CX channel
    /// (`STOREFRONT_ORG_ID`). `None` keeps the legacy tenant #1 default for public
    /// sales/support intake routes. Set it to the storefront tenant's real
    /// `organizations.id` when that tenant was re-minted via the console with a
    /// random uuid, so public inquiry/intake writes land in the SAME org the
    /// staff inbox reads under (#19.21/#398) instead of the `0x…a1` sentinel.
    pub storefront_org: Option<OrgId>,
    /// In-console office editor (ONLYOFFICE DocumentServer) integration. `None`
    /// unless all of `CONSOLE_OFFICE_JWT_SECRET` / `CONSOLE_OFFICE_CALLBACK_BASE_URL` /
    /// `CONSOLE_OFFICE_DOCSERVER_URL` are set; the office routes still mount but
    /// return `503 office_not_configured`.
    pub office: Option<office::OfficeConfig>,
    /// Base64-encoded, exactly 32-byte HMAC key for machine-only production
    /// ingress. Its absence leaves only that ingress route unavailable (503).
    pub production_service_principal_hmac_key: Option<[u8; 32]>,
    /// Built SPA directory (`CONSOLE_WEB_DIST`, e.g. `apps/web/dist`). When set,
    /// the backend serves it as the router FALLBACK so production is one
    /// same-origin deployable; unset means no SPA route at all.
    pub web_dist: Option<std::path::PathBuf>,
}

/// Native app-link association config for the `/.well-known/*` endpoints.
///
/// All fields are optional and default to empty: a deployment that has not yet
/// provisioned its native apps serves an empty (but well-formed) association
/// document rather than failing to boot. The empty state is logged at startup so
/// the gap is visible. Once set, the documents authorize the native apps to use
/// passkeys scoped to the WebAuthn RP domain.
#[derive(Debug, Clone, Default)]
pub struct AppLinksConfig {
    /// iOS app identifiers (`<TeamID>.<bundle-id>`), e.g. `ABCDE12345.com.sae.fsm`.
    /// From `CONSOLE_IOS_APP_IDS` (comma-separated).
    pub ios_app_ids: Vec<String>,
    /// Android application id, e.g. `com.sae.fsm`. From `CONSOLE_ANDROID_PACKAGE`.
    pub android_package: Option<String>,
    /// Android signing-cert SHA-256 fingerprints (colon-separated hex). From
    /// `CONSOLE_ANDROID_CERT_SHA256` (comma-separated for multiple signing keys).
    pub android_cert_sha256: Vec<String>,
}
