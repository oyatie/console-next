// SPDX-License-Identifier: LicenseRef-Proprietary
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

use console_platform_audit_chain::{SealSignError, SealSignTransport};
use serde::Deserialize;
use url::Url;

use crate::AppError;

/// Default connect/request budget for the custody HTTP client.
pub(crate) const CUSTODY_IO_TIMEOUT: Duration = Duration::from_secs(5);
/// Hard cap on custody JSON response size (8 KiB).
pub(crate) const CUSTODY_MAX_RESPONSE_BYTES: usize = 8 * 1024;
/// Upper bound waiting on the dedicated HTTP worker thread after its own timeout.
const CHANNEL_REPLY_GRACE: Duration = Duration::from_secs(2);

struct CustodySignRequest {
    key_ref: String,
    message_hex: String,
    reply: mpsc::SyncSender<Result<Vec<u8>, SealSignError>>,
}

/// Sync-callable HTTPS/HTTP client for the out-of-process custody signing
/// daemon, backed by a dedicated `current_thread` Tokio + `reqwest` (`rustls`)
/// worker thread so `SealSignTransport::sign` works safely from any context.
pub struct HttpCustodyTransport {
    state: Result<(Mutex<mpsc::SyncSender<CustodySignRequest>>, Duration), String>,
}

impl HttpCustodyTransport {
    #[cfg(all(test, not(feature = "test-postgres")))]
    #[must_use]
    pub fn new(url: Url, token: Option<String>) -> Self {
        match Self::try_new(url, token, None, CUSTODY_IO_TIMEOUT) {
            Ok(transport) => transport,
            Err(err) => Self {
                state: Err(err.to_string()),
            },
        }
    }

    pub fn try_new(
        url: Url,
        token: Option<String>,
        ca_pem: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<Self, AppError> {
        let client = build_reqwest_client(&url, ca_pem, timeout)?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| AppError::Config(format!("custody HTTP runtime init failed: {err}")))?;
        let (tx, rx) = mpsc::sync_channel::<CustodySignRequest>(8);
        thread::Builder::new()
            .name("audit-custody-http".to_owned())
            .spawn(move || {
                while let Ok(req) = rx.recv() {
                    let outcome = rt.block_on(send_custody_request(
                        &client,
                        &url,
                        token.as_deref(),
                        &req.key_ref,
                        &req.message_hex,
                    ));
                    let _ = req.reply.send(outcome);
                }
            })
            .map_err(|err| AppError::Config(format!("custody HTTP thread spawn failed: {err}")))?;
        Ok(Self {
            state: Ok((Mutex::new(tx), timeout)),
        })
    }
}

fn build_reqwest_client(
    url: &Url,
    ca_pem: Option<&[u8]>,
    timeout: Duration,
) -> Result<reqwest::Client, AppError> {
    let mut builder = reqwest::Client::builder()
        .https_only(url.scheme() == "https")
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout)
        .timeout(timeout);
    if let Some(pem) = ca_pem {
        let certs = reqwest::Certificate::from_pem_bundle(pem).map_err(|err| {
            AppError::Config(format!("invalid custody CA PEM certificate bundle: {err}"))
        })?;
        if certs.is_empty() {
            return Err(AppError::Config(
                "custody CA PEM certificate bundle is empty".to_owned(),
            ));
        }
        for cert in certs {
            builder = builder.add_root_certificate(cert);
        }
    }
    builder
        .build()
        .map_err(|err| AppError::Config(format!("custody HTTP client build failed: {err}")))
}

async fn send_custody_request(
    client: &reqwest::Client,
    url: &Url,
    token: Option<&str>,
    key_ref: &str,
    message_hex: &str,
) -> Result<Vec<u8>, SealSignError> {
    let mut builder = client.post(url.clone()).json(&serde_json::json!({
        "key_ref": key_ref,
        "message_hex": message_hex,
    }));
    if let Some(token) = token {
        builder = builder.bearer_auth(token);
    }
    let mut resp = builder
        .send()
        .await
        .map_err(|err| SealSignError::Unavailable(format!("custody request failed: {err}")))?;
    if resp.status() != reqwest::StatusCode::OK {
        return Err(SealSignError::Unavailable(format!(
            "custody HTTP non-200: {}",
            resp.status()
        )));
    }
    if let Some(len) = resp.content_length()
        && len > CUSTODY_MAX_RESPONSE_BYTES as u64
    {
        return Err(SealSignError::Unavailable(format!(
            "custody response Content-Length {len} exceeds {CUSTODY_MAX_RESPONSE_BYTES} byte cap"
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|err| SealSignError::Unavailable(format!("custody read failed: {err}")))?
    {
        if body.len().saturating_add(chunk.len()) > CUSTODY_MAX_RESPONSE_BYTES {
            return Err(SealSignError::Unavailable(format!(
                "custody streamed response exceeds {CUSTODY_MAX_RESPONSE_BYTES} byte cap"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    parse_custody_json_body(&body)
}

impl SealSignTransport for HttpCustodyTransport {
    fn sign(&self, key_ref: &str, message: &[u8]) -> Result<Vec<u8>, SealSignError> {
        let (tx_mutex, timeout) = match &self.state {
            Ok(inner) => inner,
            Err(err) => return Err(SealSignError::Unavailable(err.clone())),
        };
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let req = CustodySignRequest {
            key_ref: key_ref.to_owned(),
            message_hex: hex::encode(message),
            reply: reply_tx,
        };
        {
            let guard = tx_mutex.lock().map_err(|_| {
                SealSignError::Unavailable("custody HTTP client mutex poisoned".to_owned())
            })?;
            guard.send(req).map_err(|_| {
                SealSignError::Unavailable("custody HTTP worker channel closed".to_owned())
            })?;
        }
        reply_rx
            .recv_timeout(timeout.saturating_add(CHANNEL_REPLY_GRACE))
            .map_err(|err| {
                SealSignError::Unavailable(format!("custody HTTP worker response failed: {err}"))
            })?
    }
}

#[derive(Debug, Deserialize)]
struct CustodySignResponse {
    signature_hex: String,
}

fn parse_custody_json_body(body: &[u8]) -> Result<Vec<u8>, SealSignError> {
    let parsed: CustodySignResponse = serde_json::from_slice(body)
        .map_err(|err| SealSignError::Unavailable(format!("custody response JSON: {err}")))?;
    let bytes = hex::decode(parsed.signature_hex.trim()).map_err(|_| {
        SealSignError::Unavailable("custody signature_hex is not valid hex".to_owned())
    })?;
    if bytes.len() != 64 {
        return Err(SealSignError::Unavailable(format!(
            "custody signature length {} != 64",
            bytes.len()
        )));
    }
    Ok(bytes)
}
