//! Inbound IMAP adapter for webmail (B-mail-3).
//!
//! Implements the [`ImapClient`] port over `async-imap` + `tokio-rustls`:
//!
//! * **SSRF guard** ([`ssrf`]): before any connect, the admin-configured IMAP
//!   host is resolved once via `hickory-resolver`, every resolved IP is
//!   denylist-checked (RFC1918 / loopback / link-local incl. cloud metadata /
//!   ULA / CGNAT, IPv4-mapped IPv6 un-mapped first), and the FIRST allowed IP is
//!   PINNED for the dial — DNS-rebinding safe. The IMAP port allowlist (993/143)
//!   is re-asserted defensively.
//! * **TLS enforced** (single rustls 0.23 stack): `SslTls` (993) does an implicit
//!   TLS handshake on connect; `StartTls` (143) connects plaintext then issues
//!   `STARTTLS` and upgrades. Certificate verification uses the webpki roots via
//!   the rustls `aws-lc-rs` provider; the SNI/cert name is the ORIGINAL hostname even
//!   though we dial the pinned IP, so verification still matches. There is no
//!   plaintext path and no permissive verifier.
//! * **Mirror-in** ([`parse`]): `UID FETCH ... BODY.PEEK[]` (side-effect free —
//!   never sets `\Seen`) → `mail-parser` → the application's `FetchedMessage`.
//!
//! This is the ONLY crate where `async-imap`/`mail-parser`/`tokio-rustls` appear.
//! No secret, recipient, body, or host is logged; transport failures map to a
//! fixed, non-secret error code.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod parse;
mod session;
use session::AsyncImapSession;
pub mod ssrf;

use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use async_imap::{Client, Session};
use console_comms_application::{
    ALLOWED_IMAP_PORTS, ImapClient, ImapSession, ImapTransportConfig, MailFuture, MailServiceError,
    TestConnectionResult,
};
use console_comms_domain::MailSecurity;
use hickory_resolver::Resolver;
use secrecy::ExposeSecret;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

use crate::ssrf::SsrfError;

/// How long to wait for the TCP connect + TLS handshake before giving up. Bounds
/// the test-connection / sync probe so a black-holed host cannot wedge a worker.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// The inbound IMAP client. Stateless: each connect resolves + validates the host
/// and builds a one-shot TLS session, so a credential or host change always takes
/// effect immediately and no secret is cached across passes.
#[derive(Debug, Default, Clone)]
pub struct AsyncImapClient;

impl AsyncImapClient {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Resolve + pin the host, dial the pinned IP, and complete the TLS handshake
    /// (implicit for 993, STARTTLS for 143). Returns an authenticated session.
    async fn open_session(
        config: &ImapTransportConfig,
    ) -> Result<Session<TlsStream<TcpStream>>, MailServiceError> {
        // Defense-in-depth: re-assert the IMAP port allowlist at the transport.
        if !ALLOWED_IMAP_PORTS.contains(&config.port) {
            return Err(MailServiceError::Transport {
                code: "port_not_allowed",
            });
        }

        let pinned = resolve_and_pin(&config.host)
            .await
            .map_err(|err| MailServiceError::Transport { code: err.code() })?;

        let tls = connect_tls(config, pinned).await?;
        let client = Client::new(tls);

        // LOGIN with the decrypted credential. On failure the tuple's Client half
        // is dropped here (closing the socket); we map to a fixed auth code.
        let session = client
            .login(&config.username, config.password.expose_secret())
            .await
            .map_err(|_| MailServiceError::Transport {
                code: "auth_failed",
            })?;
        Ok(session)
    }
}

/// Establish the TLS stream to the pinned IP, with SNI = the original hostname.
async fn connect_tls(
    config: &ImapTransportConfig,
    pinned: IpAddr,
) -> Result<TlsStream<TcpStream>, MailServiceError> {
    let server_name =
        ServerName::try_from(config.host.clone()).map_err(|_| MailServiceError::Transport {
            code: "invalid_host",
        })?;
    let connector = TlsConnector::from(Arc::new(tls_client_config()?));

    let addr = std::net::SocketAddr::new(pinned, config.port);
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| MailServiceError::Transport {
            code: "connect_timeout",
        })?
        .map_err(|_| MailServiceError::Transport {
            code: "connect_failed",
        })?;

    match config.security {
        // Implicit TLS on connect (IMAPS / 993): handshake immediately.
        MailSecurity::SslTls => {
            tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(server_name, tcp))
                .await
                .map_err(|_| MailServiceError::Transport {
                    code: "tls_timeout",
                })?
                .map_err(|_| MailServiceError::Transport {
                    code: "tls_handshake",
                })
        }
        // STARTTLS (143): negotiate the upgrade on the plaintext socket, THEN
        // wrap it in TLS. async-imap 0.11 exposes no pre-login command method, so
        // we drive the (trivial, well-defined) STARTTLS line exchange directly:
        // read the server greeting, send `STARTTLS`, require a tagged `OK`, and
        // only then hand the socket to rustls. If the server does not reply OK we
        // ERROR — there is NO silent plaintext fallback.
        MailSecurity::StartTls => {
            let mut tcp = tcp;
            tokio::time::timeout(CONNECT_TIMEOUT, negotiate_starttls(&mut tcp))
                .await
                .map_err(|_| MailServiceError::Transport {
                    code: "tls_timeout",
                })??;
            tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(server_name, tcp))
                .await
                .map_err(|_| MailServiceError::Transport {
                    code: "tls_timeout",
                })?
                .map_err(|_| MailServiceError::Transport {
                    code: "tls_handshake",
                })
        }
    }
}

/// Drive the IMAP STARTTLS line exchange on the raw plaintext socket: consume the
/// server greeting, send a tagged `STARTTLS`, and require a tagged `OK` before
/// the caller upgrades to TLS. Any other response (or a connection that refuses
/// the upgrade) is an error — never a plaintext fallback.
async fn negotiate_starttls<S>(stream: &mut S) -> Result<(), MailServiceError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;

    // Read until we have at least one complete line (the untagged greeting). A
    // small bounded read loop; the greeting is a single short line.
    let _greeting = read_line(stream).await?;

    stream
        .write_all(b"a1 STARTTLS\r\n")
        .await
        .map_err(|_| MailServiceError::Transport {
            code: "starttls_failed",
        })?;
    stream.flush().await.ok();

    // Require a tagged OK for our `a1` STARTTLS. Untagged lines (`* ...`) before
    // the tagged response are skipped.
    loop {
        let line = read_line(stream).await?;
        let upper = line.trim().to_ascii_uppercase();
        if upper.starts_with("A1 OK") {
            return Ok(());
        }
        if upper.starts_with("A1 ") {
            // A1 NO / A1 BAD — the server refused STARTTLS.
            return Err(MailServiceError::Transport {
                code: "starttls_refused",
            });
        }
        // An untagged `* ...` continuation: keep reading for the tagged reply.
    }
}

/// Read a single CRLF-terminated line (bounded) from a plaintext stream during
/// STARTTLS negotiation. Errors on EOF or an over-long line so a hostile server
/// cannot wedge or balloon the handshake.
async fn read_line<S>(stream: &mut S) -> Result<String, MailServiceError>
where
    S: AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::with_capacity(128);
    let mut byte = [0u8; 1];
    loop {
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|_| MailServiceError::Transport {
                code: "starttls_failed",
            })?;
        if n == 0 {
            return Err(MailServiceError::Transport {
                code: "starttls_failed",
            });
        }
        if byte[0] == b'\n' {
            break;
        }
        if byte[0] != b'\r' {
            buf.push(byte[0]);
        }
        if buf.len() > 4096 {
            return Err(MailServiceError::Transport {
                code: "starttls_failed",
            });
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Build the rustls client config: webpki roots, the `aws-lc-rs` crypto provider, no
/// client auth, default (safe TLS 1.2 + 1.3) protocol versions. No permissive
/// verifier. Built explicitly on the `aws-lc-rs` provider so it never depends on a
/// process-global default provider (which may be unset in a worker process).
fn tls_client_config() -> Result<ClientConfig, MailServiceError> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(tokio_rustls::rustls::crypto::aws_lc_rs::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        // Only errors on an inconsistent provider/version set, which the bundled
        // aws-lc-rs provider is not; map to a fixed code rather than panicking.
        .map_err(|_| MailServiceError::Transport { code: "tls_setup" })?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(config)
}

impl ImapClient for AsyncImapClient {
    fn connect<'a>(
        &'a self,
        config: &'a ImapTransportConfig,
    ) -> MailFuture<'a, Result<Box<dyn ImapSession>, MailServiceError>> {
        Box::pin(async move {
            let session = Self::open_session(config).await?;
            Ok(Box::new(AsyncImapSession {
                session: Some(session),
            }) as Box<dyn ImapSession>)
        })
    }

    fn test_connection<'a>(
        &'a self,
        config: &'a ImapTransportConfig,
    ) -> MailFuture<'a, Result<TestConnectionResult, MailServiceError>> {
        Box::pin(async move {
            match Self::open_session(config).await {
                Ok(mut session) => {
                    // Clean logout; ignore the result (best-effort).
                    let _ = session.logout().await;
                    Ok(TestConnectionResult {
                        ok: true,
                        error_code: None,
                    })
                }
                Err(MailServiceError::Transport { code }) => Ok(TestConnectionResult {
                    ok: false,
                    error_code: Some(code.to_owned()),
                }),
                Err(other) => Err(other),
            }
        })
    }
}

/// Resolve `host` once and return the single pinned IP to dial. A host that is
/// itself an IP literal is validated directly (no DNS).
async fn resolve_and_pin(host: &str) -> Result<IpAddr, SsrfError> {
    let host = host.trim();
    if host.is_empty() {
        return Err(SsrfError::InvalidHost);
    }
    if let Ok(ip) = IpAddr::from_str(host) {
        return ssrf::pick_pinned_ip(&[ip]);
    }

    let resolver = Resolver::builder_tokio()
        .map_err(|_| SsrfError::Unresolvable)?
        .build()
        .map_err(|_| SsrfError::Unresolvable)?;
    let lookup = resolver
        .lookup_ip(host)
        .await
        .map_err(|_| SsrfError::Unresolvable)?;
    let addresses: Vec<IpAddr> = lookup.iter().collect();
    ssrf::pick_pinned_ip(&addresses)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_and_pin_rejects_private_and_metadata_literals() {
        assert_eq!(
            resolve_and_pin("127.0.0.1").await,
            Err(SsrfError::DisallowedAddress)
        );
        assert_eq!(
            resolve_and_pin("169.254.169.254").await,
            Err(SsrfError::DisallowedAddress)
        );
        assert_eq!(
            resolve_and_pin("10.0.0.5").await,
            Err(SsrfError::DisallowedAddress)
        );
    }

    #[tokio::test]
    async fn resolve_and_pin_accepts_public_literal() {
        assert_eq!(
            resolve_and_pin("8.8.8.8").await.unwrap(),
            "8.8.8.8".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn tls_config_builds_with_webpki_roots() {
        // Building the client config must succeed (aws-lc-rs provider) and load real
        // roots — the verifier path is wired and the config is usable.
        let cfg = tls_client_config().expect("aws-lc-rs-backed client config must build");
        let _ = Arc::new(cfg);
        assert!(!webpki_roots::TLS_SERVER_ROOTS.is_empty());
    }
}
