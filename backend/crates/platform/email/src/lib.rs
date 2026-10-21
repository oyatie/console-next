//! Outbound email provider adapter.
//!
//! Sends transactional email (e.g. the open-signup OTP) over SMTP via an
//! authenticated STARTTLS relay — the OCI Email Delivery endpoint in production.
//! TLS is provided by `lettre`' bundled rustls backend (the workspace ships no
//! other TLS stack: `reqwest` is built `default-features = false`), so this crate
//! pulls `lettre` with `tokio1-rustls-tls` and nothing system-native.
//!
//! Mirrors the provider-adapter shape of `console-platform-push`: a `*Config` with a
//! `validate()`, an async sender trait, a live adapter, and explicit non-prod
//! stub/disabled senders for local/e2e safety.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::fmt::{Display, Formatter};
use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;
use std::time::Duration;

use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

mod rendered;
pub use rendered::{RESERVED_HEADERS, RenderedEmail};

/// Bound on one whole SMTP submission (connect, greeting, TLS, auth, DATA).
/// lettre's own async timeout covers only the TCP connect (its default is 60 s),
/// so a relay that accepts and then stalls would otherwise hang the caller
/// forever (TOP-A1, ADR-016 §4).
pub const SMTP_TIMEOUT: Duration = Duration::from_secs(10);

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, thiserror::Error)]
pub enum EmailError {
    #[error("invalid email configuration: {0}")]
    Config(String),

    #[error("failed to build email message: {0}")]
    Message(String),

    #[error("SMTP delivery failed: {0}")]
    Transport(String),
}

/// SMTP relay configuration for outbound transactional email.
///
/// In production these point at the OCI Email Delivery STARTTLS relay; the
/// `username`/`password` are the SMTP credentials issued for the approved
/// sender. Every field is required — a partially-configured relay is a
/// misconfiguration, surfaced by [`SmtpEmailConfig::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpEmailConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from_address: String,
    pub from_name: String,
}

impl SmtpEmailConfig {
    pub fn validate(&self) -> Result<(), EmailError> {
        require_non_empty(&self.host, "SMTP host")?;
        if self.port == 0 {
            return Err(EmailError::Config("SMTP port is required".to_owned()));
        }
        require_non_empty(&self.username, "SMTP username")?;
        require_non_empty(&self.password, "SMTP password")?;
        require_non_empty(&self.from_address, "email from address")?;
        require_non_empty(&self.from_name, "email from name")
    }
}

/// Outbound transactional email port. Async by way of `BoxFuture` so the trait
/// stays object-safe behind `Arc<dyn EmailSender>` (mirrors `PushNotifier`).
pub trait EmailSender: Send + Sync {
    /// Send a one-time-passcode email to `to`. `ttl` is rendered into the body so
    /// the recipient knows how long the code is valid.
    fn send_otp<'a>(
        &'a self,
        to: &'a str,
        code: &'a str,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<(), EmailError>>;

    /// Send a message the caller already rendered, with its extra headers.
    /// The sender address is always the configured one.
    fn send_rendered<'a>(
        &'a self,
        email: &'a RenderedEmail,
    ) -> BoxFuture<'a, Result<(), EmailError>>;

    /// False for the fail-closed [`DisabledEmailSender`]: a caller whose whole
    /// purpose is a mail (open sign-up) refuses before writing anything.
    fn can_send(&self) -> bool {
        true
    }
}

/// Explicit non-production modes that are allowed to use the OTP-logging stub.
///
/// Production must use [`LettreSmtpSender`] or a fail-closed sender; constructing
/// [`StubEmailSender`] requires choosing one of these modes at the app boundary so
/// OTP logging is auditable and cannot be reached by accidental missing SMTP
/// configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StubEmailMode {
    Local,
    Development,
    Test,
    E2e,
}

impl StubEmailMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Development => "development",
            Self::Test => "test",
            Self::E2e => "e2e",
        }
    }
}

impl Display for StubEmailMode {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "unsupported email stub mode {value:?}; expected one of local, dev, development, test, or e2e"
)]
pub struct StubEmailModeParseError {
    value: String,
}

impl FromStr for StubEmailMode {
    type Err = StubEmailModeParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let normalized = value.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "local" => Ok(Self::Local),
            "dev" | "development" => Ok(Self::Development),
            "test" => Ok(Self::Test),
            "e2e" => Ok(Self::E2e),
            _ => Err(StubEmailModeParseError {
                value: value.to_owned(),
            }),
        }
    }
}

/// Live SMTP sender over an authenticated STARTTLS relay (OCI Email Delivery).
#[derive(Clone)]
pub struct LettreSmtpSender {
    config: SmtpEmailConfig,
    transport: AsyncSmtpTransport<Tokio1Executor>,
    timeout: Duration,
}

impl LettreSmtpSender {
    pub fn new(config: SmtpEmailConfig) -> Result<Self, EmailError> {
        Self::with_timeout(config, SMTP_TIMEOUT)
    }

    fn with_timeout(config: SmtpEmailConfig, timeout: Duration) -> Result<Self, EmailError> {
        config.validate()?;
        let transport = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
            .map_err(|err| EmailError::Config(err.to_string()))?
            .port(config.port)
            .timeout(Some(timeout))
            .credentials(Credentials::new(
                config.username.clone(),
                config.password.clone(),
            ))
            .build();
        Ok(Self {
            config,
            transport,
            timeout,
        })
    }

    async fn submit(&self, message: Message) -> Result<(), EmailError> {
        match tokio::time::timeout(self.timeout, self.transport.send(message)).await {
            Ok(sent) => sent
                .map(drop)
                .map_err(|err| EmailError::Transport(err.to_string())),
            Err(_) => Err(EmailError::Transport(format!(
                "SMTP submission timed out after {:?}",
                self.timeout
            ))),
        }
    }
}

impl EmailSender for LettreSmtpSender {
    fn send_otp<'a>(
        &'a self,
        to: &'a str,
        code: &'a str,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<(), EmailError>> {
        Box::pin(async move {
            let from = format!("{} <{}>", self.config.from_name, self.config.from_address);
            let message =
                Message::builder()
                    .from(from.parse().map_err(|err| {
                        EmailError::Message(format!("invalid from address: {err}"))
                    })?)
                    .to(to.parse().map_err(|err| {
                        EmailError::Message(format!("invalid recipient address: {err}"))
                    })?)
                    .subject("Your verification code")
                    .body(otp_body(code, ttl))
                    .map_err(|err| EmailError::Message(err.to_string()))?;
            self.submit(message).await
        })
    }

    fn send_rendered<'a>(
        &'a self,
        email: &'a RenderedEmail,
    ) -> BoxFuture<'a, Result<(), EmailError>> {
        Box::pin(async move {
            let message = rendered::build_message(&self.config, email)?;
            self.submit(message).await
        })
    }
}

/// Fail-closed sender used when neither live SMTP nor explicit stub mode is
/// configured. It never logs OTPs; callers get a configuration error instead.
#[derive(Debug, Clone, Default)]
pub struct DisabledEmailSender;

impl EmailSender for DisabledEmailSender {
    fn send_otp<'a>(
        &'a self,
        _to: &'a str,
        _code: &'a str,
        _ttl: Duration,
    ) -> BoxFuture<'a, Result<(), EmailError>> {
        Box::pin(async move {
            Err(EmailError::Config(
                "outbound OTP email is disabled because neither live SMTP config nor explicit non-production stub mode is configured"
                    .to_owned(),
            ))
        })
    }

    fn send_rendered<'a>(
        &'a self,
        _email: &'a RenderedEmail,
    ) -> BoxFuture<'a, Result<(), EmailError>> {
        Box::pin(async move {
            Err(EmailError::Config(
                "outbound email is disabled: no live SMTP config and no explicit non-production stub mode"
                    .to_owned(),
            ))
        })
    }

    fn can_send(&self) -> bool {
        false
    }
}

/// Stub sender for explicit non-production dev/e2e/test flows. Logs the OTP via
/// `tracing` and returns `Ok(())` — it NEVER sends mail.
#[derive(Debug, Clone)]
pub struct StubEmailSender {
    mode: StubEmailMode,
}

impl StubEmailSender {
    #[must_use]
    pub const fn new(mode: StubEmailMode) -> Self {
        Self { mode }
    }

    #[must_use]
    pub const fn mode(&self) -> StubEmailMode {
        self.mode
    }
}

impl EmailSender for StubEmailSender {
    fn send_otp<'a>(
        &'a self,
        to: &'a str,
        code: &'a str,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<(), EmailError>> {
        Box::pin(async move {
            tracing::info!(
                target: "console::email",
                email_stub_mode = %self.mode,
                "[NONPROD:{}] OTP for {to}: {code} (ttl {ttl:?})",
                self.mode
            );
            Ok(())
        })
    }

    fn send_rendered<'a>(
        &'a self,
        email: &'a RenderedEmail,
    ) -> BoxFuture<'a, Result<(), EmailError>> {
        Box::pin(async move {
            tracing::info!(
                target: "console::email",
                email_stub_mode = %self.mode,
                "[NONPROD:{}] mail for {}: {}\n{}",
                self.mode,
                email.to,
                email.subject,
                email.text
            );
            Ok(())
        })
    }
}

fn otp_body(code: &str, ttl: Duration) -> String {
    let minutes = ttl.as_secs() / 60;
    format!(
        "Your verification code is {code}.\n\nIt expires in {minutes} minutes.\n\nIf you did not request this, you can ignore this email.\n"
    )
}

fn require_non_empty(value: &str, name: &str) -> Result<(), EmailError> {
    if value.trim().is_empty() {
        Err(EmailError::Config(format!("{name} is required")))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_config() -> SmtpEmailConfig {
        SmtpEmailConfig {
            host: "smtp.email.ap-chuncheon-1.oci.oraclecloud.com".to_owned(),
            port: 587,
            username: "ocid1.user.oc1..example".to_owned(),
            password: "secret".to_owned(),
            from_address: "noreply@example.com".to_owned(),
            from_name: "Console".to_owned(),
        }
    }

    #[test]
    fn valid_config_passes_validation() {
        assert!(valid_config().validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_host() {
        let mut config = valid_config();
        config.host = String::new();
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_zero_port() {
        let mut config = valid_config();
        config.port = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_blank_from_name() {
        let mut config = valid_config();
        config.from_name = "   ".to_owned();
        assert!(config.validate().is_err());
    }

    #[test]
    fn stub_mode_parses_only_explicit_non_production_values() {
        assert_eq!(
            "local".parse::<StubEmailMode>().unwrap(),
            StubEmailMode::Local
        );
        assert_eq!(
            "dev".parse::<StubEmailMode>().unwrap(),
            StubEmailMode::Development
        );
        assert_eq!(
            "development".parse::<StubEmailMode>().unwrap(),
            StubEmailMode::Development
        );
        assert_eq!(
            "test".parse::<StubEmailMode>().unwrap(),
            StubEmailMode::Test
        );
        assert_eq!("e2e".parse::<StubEmailMode>().unwrap(), StubEmailMode::E2e);
        assert!("production".parse::<StubEmailMode>().is_err());
        assert!("true".parse::<StubEmailMode>().is_err());
    }

    #[tokio::test]
    async fn stub_sender_never_fails_and_does_not_send() {
        let sender = StubEmailSender::new(StubEmailMode::Test);
        let result = sender
            .send_otp("ops@example.com", "123456", Duration::from_secs(300))
            .await;
        assert!(result.is_ok());
    }

    fn rendered() -> RenderedEmail {
        RenderedEmail {
            to: "ops@example.com".to_owned(),
            from_name: None,
            subject: "Code".to_owned(),
            text: "123456".to_owned(),
            html: None,
            headers: vec![("Auto-Submitted".to_owned(), "auto-generated".to_owned())],
        }
    }

    #[test]
    fn live_sender_uses_the_ten_second_bound() {
        assert_eq!(SMTP_TIMEOUT, Duration::from_secs(10));
        assert_eq!(
            LettreSmtpSender::new(valid_config()).unwrap().timeout,
            SMTP_TIMEOUT
        );
    }

    #[tokio::test]
    async fn a_relay_that_accepts_and_stalls_fails_within_the_bound() {
        // The kernel completes the handshake from the backlog; nothing ever greets.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut config = valid_config();
        config.host = "127.0.0.1".to_owned();
        config.port = listener.local_addr().unwrap().port();
        let sender = LettreSmtpSender::with_timeout(config, Duration::from_millis(300)).unwrap();
        let started = std::time::Instant::now();
        let result = sender.send_rendered(&rendered()).await;
        assert!(
            matches!(&result, Err(EmailError::Transport(message)) if message.contains("timed out")),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(listener);
    }

    #[tokio::test]
    async fn disabled_sender_refuses_rendered_mail() {
        let result = DisabledEmailSender.send_rendered(&rendered()).await;
        assert!(matches!(result, Err(EmailError::Config(message)) if message.contains("disabled")));
    }

    #[tokio::test]
    async fn stub_sender_accepts_rendered_mail_without_sending() {
        let sender = StubEmailSender::new(StubEmailMode::Test);
        assert!(sender.send_rendered(&rendered()).await.is_ok());
    }

    #[tokio::test]
    async fn disabled_sender_fails_closed_without_logging_otp() {
        let sender = DisabledEmailSender;
        let result = sender
            .send_otp("ops@example.com", "123456", Duration::from_secs(300))
            .await;
        assert!(matches!(result, Err(EmailError::Config(message)) if message.contains("disabled")));
    }
}
