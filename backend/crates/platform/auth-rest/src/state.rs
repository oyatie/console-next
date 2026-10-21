use crate::config::AuthRestConfig;
use crate::config::AuthRestConfigError;
use crate::error::RestError;
use console_platform_auth::JwtIssuer;
use console_platform_auth::JwtSettings;
use console_platform_auth::JwtVerifier;
use console_platform_auth::PasskeyService;
use console_platform_auth::RefreshTokenStore;
use console_platform_auth::WebauthnSettings;
use console_platform_email::DisabledEmailSender;
use console_platform_email::EmailSender;
use console_platform_provisioning::BootstrapCredentialStore;
use sqlx::PgPool;
use std::sync::Arc;
use time::Duration;
use url::Url;

#[derive(Clone)]
pub struct AuthRestState {
    pub(crate) pool: PgPool,
    pub(crate) services: Option<AuthServices>,
}

impl std::fmt::Debug for AuthRestState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthRestState")
            .field("services_configured", &self.services.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub(crate) struct AuthServices {
    pub(crate) passkeys: PasskeyService,
    pub(crate) jwt_issuer: JwtIssuer,
    pub(crate) jwt_verifier: JwtVerifier,
    pub(crate) refresh_tokens: RefreshTokenStore,
    pub(crate) bootstrap_credentials: BootstrapCredentialStore,
    /// The console's public origin (the WebAuthn RP origin, e.g.
    /// `https://console.example.com`). Used to build the cross-device
    /// passkey-enrollment handoff URL the frontend renders as a QR; the phone
    /// opens it to redeem the handoff and enroll a passkey. Always a validated,
    /// scheme+host origin with no path/query (parsed once at config time).
    pub(crate) rp_origin: Url,
    pub(crate) refresh_token_ttl: Duration,
    pub(crate) refresh_family_absolute_ttl: Duration,
    pub(crate) cookie_secure: bool,
    /// Outbound OTP email sender for open self-service signup (#38). Always
    /// present: live SMTP, an explicitly configured non-prod stub, or a disabled
    /// fail-closed sender that never logs OTPs.
    pub(crate) email_sender: Arc<dyn EmailSender>,
}

impl AuthRestState {
    #[must_use]
    pub fn disabled(pool: PgPool) -> Self {
        Self {
            pool,
            services: None,
        }
    }

    pub fn new(pool: PgPool, config: AuthRestConfig) -> Result<Self, AuthRestConfigError> {
        let rp_origin = Url::parse(&config.rp_origin)?;
        // Keep a copy of the validated origin to build the cross-device enrollment
        // handoff URL; `WebauthnSettings` takes ownership of the other clone below.
        let handoff_origin = rp_origin.clone();
        let passkeys = PasskeyService::new(WebauthnSettings {
            rp_id: config.rp_id,
            rp_origin,
            rp_name: config.rp_name,
            extra_allowed_origins: Vec::new(),
            ceremony_ttl: config.ceremony_ttl,
        })?;
        let jwt_settings = JwtSettings {
            issuer: config.jwt_issuer,
            audience: config.jwt_audience,
            access_token_ttl: config.access_token_ttl,
        };
        let jwt_issuer = JwtIssuer::from_es256_pem(
            jwt_settings.clone(),
            config.jwt_private_key_pem.as_bytes(),
            config.jwt_public_key_pem.as_bytes(),
        )?;
        let jwt_verifier =
            JwtVerifier::from_es256_public_pem(jwt_settings, config.jwt_public_key_pem.as_bytes())?;

        Ok(Self {
            pool,
            services: Some(AuthServices {
                passkeys,
                jwt_issuer,
                jwt_verifier,
                refresh_tokens: RefreshTokenStore,
                bootstrap_credentials: BootstrapCredentialStore,
                rp_origin: handoff_origin,
                refresh_token_ttl: config.refresh_token_ttl,
                refresh_family_absolute_ttl: config.refresh_family_absolute_ttl,
                cookie_secure: config.cookie_secure,
                // Fail closed by default; the composition root installs live SMTP
                // or an explicit non-prod logging stub via `with_email_sender`.
                email_sender: Arc::new(DisabledEmailSender),
            }),
        })
    }

    /// Install the outbound OTP email sender used by the open-signup endpoint.
    /// The composition root calls this with the app's `Arc<dyn EmailSender>`
    /// (live SMTP or the logging stub). A no-op when auth services are disabled.
    #[must_use]
    pub fn with_email_sender(mut self, email_sender: Arc<dyn EmailSender>) -> Self {
        if let Some(services) = self.services.as_mut() {
            services.email_sender = email_sender;
        }
        self
    }
}

impl AuthRestState {
    pub(crate) fn services(&self) -> Result<&AuthServices, RestError> {
        self.services.as_ref().ok_or_else(|| {
            RestError::unavailable("auth REST is mounted but auth services are not configured")
        })
    }
}
