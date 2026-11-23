// SPDX-License-Identifier: LicenseRef-Proprietary

use aws_lc_rs::constant_time::verify_slices_are_equal;
use aws_lc_rs::digest::{Context as DigestContext, SHA256, digest};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use secrecy::{ExposeSecret, SecretString};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::AuthError;

const REFRESH_TOKEN_PREFIX: &str = "console_rt_";
const REFRESH_TOKEN_HASH_DOMAIN: &[u8] = b"console.refresh_token.v2\0";
const REFRESH_TOKEN_RANDOM_BYTES: usize = 32;

#[derive(Clone)]
pub struct RefreshToken(SecretString);

impl std::fmt::Debug for RefreshToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RefreshToken([REDACTED])")
    }
}

impl PartialEq for RefreshToken {
    fn eq(&self, other: &Self) -> bool {
        verify_slices_are_equal(
            self.0.expose_secret().as_bytes(),
            other.0.expose_secret().as_bytes(),
        )
        .is_ok()
    }
}

impl Eq for RefreshToken {}

impl RefreshToken {
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.expose_secret()
    }
}

pub(super) fn generate_refresh_token() -> Result<RefreshToken, AuthError> {
    let rng = SystemRandom::new();
    let mut bytes = Zeroizing::new([0u8; REFRESH_TOKEN_RANDOM_BYTES]);
    rng.fill(&mut *bytes).map_err(|_| AuthError::Csprng)?;
    let encoded = Zeroizing::new(URL_SAFE_NO_PAD.encode(*bytes));
    let mut out = String::with_capacity(REFRESH_TOKEN_PREFIX.len() + encoded.len());
    out.push_str(REFRESH_TOKEN_PREFIX);
    out.push_str(&encoded);
    Ok(RefreshToken(SecretString::from(out)))
}

pub(super) fn hash_token_v2(token: &str) -> Vec<u8> {
    let mut ctx = DigestContext::new(&SHA256);
    ctx.update(REFRESH_TOKEN_HASH_DOMAIN);
    ctx.update(token.as_bytes());
    ctx.finish().as_ref().to_vec()
}

pub(super) fn hash_token_v1(token: &str) -> Vec<u8> {
    digest(&SHA256, token.as_bytes()).as_ref().to_vec()
}

/// Resolve the family's tenant and matched `token_hash` from a presented token.
/// Tries v2 (domain-separated SHA-256) first; falls back to legacy v1 raw
/// SHA-256 only on miss so active 24h families rotate cleanly without extra DB
/// round trips for newly issued tokens.
pub(super) async fn resolve_presented_token(
    tx: &mut Transaction<'_, Postgres>,
    presented_token: &str,
) -> Result<Option<(Uuid, Vec<u8>)>, AuthError> {
    let v2 = hash_token_v2(presented_token);
    if let Some(org_uuid) = super::resolve_token_org(tx, &v2).await? {
        return Ok(Some((org_uuid, v2)));
    }
    let v1 = hash_token_v1(presented_token);
    if let Some(org_uuid) = super::resolve_token_org(tx, &v1).await? {
        return Ok(Some((org_uuid, v1)));
    }
    Ok(None)
}
