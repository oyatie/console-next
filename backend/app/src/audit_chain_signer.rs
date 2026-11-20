//! Production audit-chain seal signer wiring.
//!
//! Parses pinned trust anchors, custody endpoint URL, optional bearer token,
//! and optional custom CA PEM file from process env, constructs a TLS-capable
//! [`HttpCustodyTransport`], and hands the resulting `Arc<dyn SealSigner>` to
//! the seal worker and attestation endpoint.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::Arc;

#[path = "audit_chain_transport.rs"]
mod transport;

use console_platform_audit_chain::{ExternalSealSigner, InMemoryEd25519Signer, SealSigner};
use transport::CUSTODY_IO_TIMEOUT;
#[cfg(all(test, not(feature = "test-postgres")))]
use transport::CUSTODY_MAX_RESPONSE_BYTES;
pub use transport::HttpCustodyTransport;
use url::{Host, Url};

use crate::AppError;

/// Env-driven external seal configuration (anchors + custody transport).
#[derive(Debug, Clone)]
pub struct AuditChainExternalConfig {
    /// Active signing `key_ref` written into every new seal.
    pub key_ref: String,
    /// Locally pinned trust anchors: `key_ref` -> raw Ed25519 public key bytes.
    pub anchors: BTreeMap<String, Vec<u8>>,
    /// URL of the custody signing endpoint (`https://` or loopback `http://`).
    pub custody_url: Url,
    /// Optional bearer token sent as `Authorization: Bearer ...`.
    pub custody_token: Option<String>,
    /// Optional PEM-encoded CA bundle loaded from `CONSOLE_AUDIT_CHAIN_CUSTODY_CA_FILE`.
    pub custody_ca_pem: Option<Vec<u8>>,
}

/// Parse the optional external-seal env group (all-or-nothing fail closed).
pub fn external_config_from_vars(
    get: impl Fn(&str) -> Option<String>,
) -> Result<Option<AuditChainExternalConfig>, AppError> {
    let key_ref = non_empty(get("CONSOLE_AUDIT_CHAIN_SEAL_KEY_REF"));
    let anchors_raw = non_empty(get("CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS"));
    let custody_url_raw = non_empty(get("CONSOLE_AUDIT_CHAIN_CUSTODY_URL"));
    let custody_token = non_empty(get("CONSOLE_AUDIT_CHAIN_CUSTODY_TOKEN"));
    let custody_ca_file = non_empty(get("CONSOLE_AUDIT_CHAIN_CUSTODY_CA_FILE"));

    match (key_ref, anchors_raw, custody_url_raw) {
        (None, None, None) => {
            if custody_token.is_some() || custody_ca_file.is_some() {
                return Err(AppError::Config(
                    "CONSOLE_AUDIT_CHAIN_CUSTODY_TOKEN/CA_FILE set without KEY_REF/ANCHORS/CUSTODY_URL"
                        .to_owned(),
                ));
            }
            Ok(None)
        }
        (Some(key_ref), Some(anchors_raw), Some(custody_url_raw)) => {
            let anchors = parse_anchors(&anchors_raw)?;
            if !anchors.contains_key(&key_ref) {
                return Err(AppError::Config(format!(
                    "CONSOLE_AUDIT_CHAIN_SEAL_KEY_REF {key_ref} is not present in CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS"
                )));
            }
            let custody_url = Url::parse(&custody_url_raw).map_err(|err| {
                AppError::Config(format!("invalid CONSOLE_AUDIT_CHAIN_CUSTODY_URL: {err}"))
            })?;
            validate_custody_url(&custody_url)?;
            let custody_ca_pem = match custody_ca_file {
                Some(path) => {
                    let bytes = std::fs::read(&path).map_err(|err| {
                        AppError::Config(format!(
                            "failed to read CONSOLE_AUDIT_CHAIN_CUSTODY_CA_FILE {path}: {err}"
                        ))
                    })?;
                    if reqwest::Certificate::from_pem_bundle(&bytes).is_err_and(|_| true)
                        || reqwest::Certificate::from_pem_bundle(&bytes)
                            .map(|certs| certs.is_empty())
                            .unwrap_or(true)
                    {
                        return Err(AppError::Config(format!(
                            "CONSOLE_AUDIT_CHAIN_CUSTODY_CA_FILE {path} contains no valid PEM certificates"
                        )));
                    }
                    Some(bytes)
                }
                None => None,
            };
            Ok(Some(AuditChainExternalConfig {
                key_ref,
                anchors,
                custody_url,
                custody_token,
                custody_ca_pem,
            }))
        }
        _ => Err(AppError::Config(
            "CONSOLE_AUDIT_CHAIN_SEAL_KEY_REF, CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS, and \
             CONSOLE_AUDIT_CHAIN_CUSTODY_URL must be set together (or all unset)"
                .to_owned(),
        )),
    }
}

fn validate_custody_url(url: &Url) -> Result<(), AppError> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Config(
            "CONSOLE_AUDIT_CHAIN_CUSTODY_URL must not embed username or password".to_owned(),
        ));
    }
    let Some(host) = url.host() else {
        return Err(AppError::Config(
            "CONSOLE_AUDIT_CHAIN_CUSTODY_URL must include a host".to_owned(),
        ));
    };
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_host(&host) => Ok(()),
        "http" => Err(AppError::Config(
            "CONSOLE_AUDIT_CHAIN_CUSTODY_URL with http:// is restricted to loopback hosts; use https:// remotely"
                .to_owned(),
        )),
        _ => Err(AppError::Config(
            "CONSOLE_AUDIT_CHAIN_CUSTODY_URL must use https:// (or loopback http://)".to_owned(),
        )),
    }
}

fn is_loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => {
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        Host::Domain(domain) => {
            domain.eq_ignore_ascii_case("localhost")
                || domain.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
        }
    }
}

/// Build the attestation / seal `SealSigner` for this process.
pub fn build_attestation_signer(
    external: Option<&AuditChainExternalConfig>,
) -> Result<Arc<dyn SealSigner>, AppError> {
    match external {
        Some(cfg) => build_external_signer(cfg),
        None => Ok(Arc::new(InMemoryEd25519Signer::generate().map_err(
            |err| AppError::Internal(format!("audit-chain attestation signer init failed: {err}")),
        )?)),
    }
}

/// Resolve the seal-worker signer when `CONSOLE_AUDIT_CHAIN_SEAL_ENABLED=true`.
pub fn build_seal_worker_signer(
    external: Option<&AuditChainExternalConfig>,
    allow_dev_signer: bool,
) -> Result<Option<Arc<dyn SealSigner>>, AppError> {
    match external {
        Some(cfg) => Ok(Some(build_external_signer(cfg)?)),
        None if allow_dev_signer => Ok(Some(Arc::new(InMemoryEd25519Signer::generate().map_err(
            |err| AppError::Internal(format!("audit-chain dev seal signer init failed: {err}")),
        )?))),
        None => {
            tracing::error!(
                "CONSOLE_AUDIT_CHAIN_SEAL_ENABLED=true but external custody config is absent; \
                 seal worker NOT started"
            );
            Ok(None)
        }
    }
}

fn build_external_signer(cfg: &AuditChainExternalConfig) -> Result<Arc<dyn SealSigner>, AppError> {
    let transport = HttpCustodyTransport::try_new(
        cfg.custody_url.clone(),
        cfg.custody_token.clone(),
        cfg.custody_ca_pem.as_deref(),
        CUSTODY_IO_TIMEOUT,
    )?;
    let signer = ExternalSealSigner::new(
        cfg.key_ref.clone(),
        Arc::new(transport),
        cfg.anchors.clone(),
    )
    .map_err(|err| AppError::Config(format!("audit-chain external signer: {err}")))?;
    Ok(Arc::new(signer))
}

fn parse_anchors(raw: &str) -> Result<BTreeMap<String, Vec<u8>>, AppError> {
    let mut out = BTreeMap::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (key_ref, hex_pk) = entry.split_once('=').ok_or_else(|| {
            AppError::Config(format!(
                "CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS entry must be key_ref=hexpk, got {entry:?}"
            ))
        })?;
        let key_ref = key_ref.trim();
        let hex_pk = hex_pk.trim();
        if key_ref.is_empty() {
            return Err(AppError::Config(
                "CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS entry has empty key_ref".to_owned(),
            ));
        }
        let pk = hex::decode(hex_pk).map_err(|_| {
            AppError::Config(format!(
                "CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS public key for {key_ref} is not valid hex"
            ))
        })?;
        if pk.len() != 32 {
            return Err(AppError::Config(format!(
                "CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS public key for {key_ref} must be 32 bytes, got {}",
                pk.len()
            )));
        }
        if out.insert(key_ref.to_owned(), pk).is_some() {
            return Err(AppError::Config(format!(
                "CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS duplicate key_ref {key_ref}"
            )));
        }
    }
    if out.is_empty() {
        return Err(AppError::Config(
            "CONSOLE_AUDIT_CHAIN_SEAL_ANCHORS is empty".to_owned(),
        ));
    }
    Ok(out)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_owned())
    })
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[path = "audit_chain_signer_tests.rs"]
mod tests;
