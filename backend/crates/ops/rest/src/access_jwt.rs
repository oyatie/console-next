// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;
use std::path::Path;
use std::sync::RwLock;
use std::time::Duration;

use axum::http::HeaderMap;
use console_ops_domain::bundle::AccessSettings;
use jsonwebtoken::jwk::Jwk;
use jsonwebtoken::{DecodingKey, Validation, decode, decode_header};
use reqwest::Client;
use serde::Deserialize;
use time::OffsetDateTime;

pub use crate::jwks_validate::parse_jwks;
use crate::jwks_validate::{is_pinned_asymmetric, jwk_allows_alg};

const ACCESS_JWT_HEADER: &str = "cf-access-jwt-assertion";
const MAX_JWKS_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessJwtError {
    Missing,
    Invalid,
    AudMismatch,
}

#[derive(Clone)]
pub struct VerifiedAccessIdentity {
    pub email: String,
}

impl std::fmt::Debug for VerifiedAccessIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedAccessIdentity")
            .field("email", &"[redacted]")
            .finish()
    }
}

#[derive(Deserialize)]
struct AccessClaims {
    aud: AudienceClaim,
    email: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AudienceClaim {
    One(String),
    Many(Vec<String>),
}

impl AudienceClaim {
    fn contains(&self, expected: &str) -> bool {
        match self {
            Self::One(s) => s == expected,
            Self::Many(list) => list.iter().any(|s| s == expected),
        }
    }
}

struct JwksState {
    keys: Vec<Jwk>,
    observed_at: Option<OffsetDateTime>,
    file_mtime: Option<OffsetDateTime>,
    last_error: Option<String>,
}

pub struct AccessJwtVerifier {
    aud: String,
    issuer: String,
    jwks_source: String,
    interval_s: NonZeroU64,
    client: Client,
    state: RwLock<JwksState>,
}

impl AccessJwtVerifier {
    pub fn new(settings: &AccessSettings) -> Result<Self, String> {
        let timeout_ms = (settings.interval_s.get().saturating_mul(500)).clamp(1000, 10_000);
        let client = Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("failed to build JWKS HTTP client: {e}"))?;
        Ok(Self {
            aud: settings.aud.clone(),
            issuer: settings.issuer.clone(),
            jwks_source: settings.jwks.clone(),
            interval_s: settings.interval_s,
            client,
            state: RwLock::new(JwksState {
                keys: Vec::new(),
                observed_at: None,
                file_mtime: None,
                last_error: Some("not yet read".to_owned()),
            }),
        })
    }

    pub fn from_jwks_json(
        settings: &AccessSettings,
        jwks_json: &str,
        now: OffsetDateTime,
    ) -> Result<Self, String> {
        let verifier = Self::new(settings)?;
        let keys = parse_jwks(jwks_json)?;
        let mut guard = verifier
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.keys = keys;
        guard.observed_at = Some(now);
        guard.file_mtime = Some(now);
        guard.last_error = None;
        drop(guard);
        Ok(verifier)
    }

    pub async fn refresh(&self, now: OffsetDateTime) -> Result<(), String> {
        let result: Result<(Vec<Jwk>, Option<OffsetDateTime>), String> =
            if self.jwks_source.starts_with('/') {
                let path = Path::new(&self.jwks_source);
                let text = tokio::fs::read_to_string(path)
                    .await
                    .map_err(|e| format!("jwks read error: {e}"))?;
                let keys = parse_jwks(&text)?;
                let mtime = tokio::fs::metadata(path)
                    .await
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(OffsetDateTime::from);
                Ok((keys, mtime))
            } else {
                self.fetch_http_jwks().await.map(|keys| (keys, None))
            };

        let mut guard = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match result {
            Ok((keys, mtime)) => {
                guard.keys = keys;
                guard.observed_at = Some(now);
                guard.file_mtime = mtime;
                guard.last_error = None;
                Ok(())
            }
            Err(err) => {
                guard.last_error = Some(err.clone());
                Err(err)
            }
        }
    }

    async fn fetch_http_jwks(&self) -> Result<Vec<Jwk>, String> {
        let mut resp = self
            .client
            .get(&self.jwks_source)
            .send()
            .await
            .map_err(|e| format!("jwks fetch error: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("jwks HTTP {}", resp.status()));
        }
        if resp
            .content_length()
            .is_some_and(|len| len > MAX_JWKS_BYTES as u64)
        {
            return Err("jwks response exceeds cap".to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("jwks stream: {e}"))?
        {
            if chunk.len() > MAX_JWKS_BYTES - bytes.len() {
                return Err("jwks response exceeds cap".to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| "jwks not utf-8".to_owned())?;
        parse_jwks(text)
    }

    pub fn interval_s(&self) -> NonZeroU64 {
        self.interval_s
    }

    pub fn jwks_age_seconds(&self, now: OffsetDateTime) -> u64 {
        let guard = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match guard.file_mtime.or(guard.observed_at) {
            Some(at) => u64::try_from((now - at).whole_seconds()).unwrap_or_default(),
            None => 0,
        }
    }

    pub fn status(&self) -> (Option<OffsetDateTime>, Option<String>) {
        let guard = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (guard.observed_at, guard.last_error.clone())
    }

    pub fn verify_headers(
        &self,
        headers: &HeaderMap,
    ) -> Result<VerifiedAccessIdentity, AccessJwtError> {
        let raw = headers
            .get(ACCESS_JWT_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or(AccessJwtError::Missing)?;
        self.verify_token(raw)
    }

    pub fn verify_token(&self, token: &str) -> Result<VerifiedAccessIdentity, AccessJwtError> {
        let header = decode_header(token).map_err(|_| AccessJwtError::Invalid)?;
        if !is_pinned_asymmetric(header.alg) {
            return Err(AccessJwtError::Invalid);
        }
        let kid = header
            .kid
            .as_deref()
            .filter(|k| !k.is_empty())
            .ok_or(AccessJwtError::Invalid)?;

        let decoding_key = {
            let guard = self
                .state
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let jwk = guard
                .keys
                .iter()
                .find(|k| k.common.key_id.as_deref() == Some(kid))
                .ok_or(AccessJwtError::Invalid)?;
            if !jwk_allows_alg(jwk, header.alg) {
                return Err(AccessJwtError::Invalid);
            }
            DecodingKey::from_jwk(jwk).map_err(|_| AccessJwtError::Invalid)?
        };

        let mut validation = Validation::new(header.alg);
        validation.leeway = 0;
        validation.validate_exp = true;
        validation.validate_nbf = true;
        validation.validate_aud = false;
        validation.set_issuer(&[self.issuer.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "email"]);

        let decoded = decode::<AccessClaims>(token, &decoding_key, &validation)
            .map_err(|_| AccessJwtError::Invalid)?;

        if !decoded.claims.aud.contains(&self.aud) {
            return Err(AccessJwtError::AudMismatch);
        }
        let email = decoded.claims.email.as_str();
        if !is_valid_email(email) {
            return Err(AccessJwtError::Invalid);
        }
        Ok(VerifiedAccessIdentity {
            email: email.to_owned(),
        })
    }
}

fn is_valid_email(raw: &str) -> bool {
    let Some((local, domain)) = raw.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && !raw.chars().any(char::is_whitespace)
}
