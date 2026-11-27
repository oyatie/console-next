// SPDX-License-Identifier: LicenseRef-Proprietary

use super::BootstrapToken;
use crate::ProvisioningError;
use aws_lc_rs::constant_time::verify_slices_are_equal;
use aws_lc_rs::digest::{Context as DigestContext, SHA256, digest};
use aws_lc_rs::hmac;
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use secrecy::{ExposeSecret, SecretBox, SecretString};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

#[path = "format.rs"]
mod format;
pub use format::*;

pub(crate) const PLATFORM_INVITE_TOKEN_PREFIX: &str = "cop_";
const PLATFORM_INVITE_HASH_DOMAIN: &[u8] = b"console.platform_operator_invite.v1\0";
const PLATFORM_INVITE_RANDOM_BYTES: usize = 32;
const BOOTSTRAP_OTP_HASH_DOMAIN: &[u8] = b"console.bootstrap_otp.v2\0";
const OTP_HMAC_KEY_LEN: usize = 32;

/// Keyed HMAC-SHA256 pepper for bootstrap OTPs (`CONSOLE_OTP_HMAC_KEY`,
/// optional `CONSOLE_OTP_HMAC_KEY_PREV` for zero-downtime key rotation).
pub struct OtpHmacKey {
    active: SecretBox<[u8; OTP_HMAC_KEY_LEN]>,
    previous: Option<SecretBox<[u8; OTP_HMAC_KEY_LEN]>>,
}

impl Clone for OtpHmacKey {
    fn clone(&self) -> Self {
        Self {
            active: SecretBox::new(Box::new(*self.active.expose_secret())),
            previous: self
                .previous
                .as_ref()
                .map(|prev| SecretBox::new(Box::new(*prev.expose_secret()))),
        }
    }
}

impl std::fmt::Debug for OtpHmacKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OtpHmacKey([REDACTED])")
    }
}

impl PartialEq for OtpHmacKey {
    fn eq(&self, other: &Self) -> bool {
        let active_eq =
            verify_slices_are_equal(self.active.expose_secret(), other.active.expose_secret())
                .is_ok();
        let prev_eq = match (&self.previous, &other.previous) {
            (Some(a), Some(b)) => {
                verify_slices_are_equal(a.expose_secret(), b.expose_secret()).is_ok()
            }
            (None, None) => true,
            _ => false,
        };
        active_eq && prev_eq
    }
}

impl Eq for OtpHmacKey {}

impl OtpHmacKey {
    #[must_use]
    pub(crate) fn active_secret_bytes(&self) -> &[u8; OTP_HMAC_KEY_LEN] {
        self.active.expose_secret()
    }

    /// Construct from raw 32-byte key material, rejecting all-zero keys.
    pub fn from_bytes(
        active: [u8; OTP_HMAC_KEY_LEN],
        previous: Option<[u8; OTP_HMAC_KEY_LEN]>,
    ) -> Result<Self, &'static str> {
        let mut active = Zeroizing::new(active);
        if active.iter().all(|&b| b == 0) {
            return Err("key must not be all zeros");
        }
        let previous_box = match previous {
            Some(prev) => {
                let prev = Zeroizing::new(prev);
                if prev.iter().all(|&b| b == 0) {
                    return Err("previous key must not be all zeros");
                }
                Some(SecretBox::new(Box::new(*prev)))
            }
            None => None,
        };
        let active_box = SecretBox::new(Box::new(*active));
        active.zeroize();
        Ok(Self {
            active: active_box,
            previous: previous_box,
        })
    }

    /// Decode active (and optional previous) key from 64-char hex or 32-byte standard base64.
    pub fn from_encoded(active: &str, previous: Option<&str>) -> Result<Self, &'static str> {
        let active_bytes = decode_hmac_key_bytes(active)?;
        let prev_bytes = previous.map(decode_hmac_key_bytes).transpose()?;
        Self::from_bytes(*active_bytes, prev_bytes.map(|b| *b))
    }

    /// Process-wide ephemeral CSPRNG key used in debug/test builds when no explicit
    /// `CONSOLE_OTP_HMAC_KEY` is configured. Compiled out of non-development builds.
    #[cfg(debug_assertions)]
    pub fn try_dev_process_key() -> Result<Self, ProvisioningError> {
        static DEV_PROCESS_KEY: std::sync::OnceLock<Result<[u8; OTP_HMAC_KEY_LEN], ()>> =
            std::sync::OnceLock::new();
        let entry = DEV_PROCESS_KEY.get_or_init(|| {
            let mut buf = [0u8; OTP_HMAC_KEY_LEN];
            if SystemRandom::new().fill(&mut buf).is_err() {
                return Err(());
            }
            Ok(buf)
        });
        match entry {
            Ok(bytes) => Ok(Self {
                active: SecretBox::new(Box::new(*bytes)),
                previous: None,
            }),
            Err(()) => Err(ProvisioningError::Conflict(
                "CSPRNG unavailable for dev OTP HMAC key".to_owned(),
            )),
        }
    }
}

fn decode_hmac_key_bytes(raw: &str) -> Result<Zeroizing<[u8; OTP_HMAC_KEY_LEN]>, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("must not be empty");
    }
    let mut out = Zeroizing::new([0u8; OTP_HMAC_KEY_LEN]);
    if trimmed.len() == OTP_HMAC_KEY_LEN * 2 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        for (idx, chunk) in trimmed.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            let hi = hex_nibble(chunk[0]).ok_or("must be valid hex or base64")?;
            let lo = hex_nibble(chunk[1]).ok_or("must be valid hex or base64")?;
            out[idx] = (hi << 4) | lo;
        }
    } else {
        let decoded = Zeroizing::new(
            BASE64_STANDARD
                .decode(trimmed)
                .map_err(|_| "must be 64 hex characters or 32-byte base64")?,
        );
        if decoded.len() != OTP_HMAC_KEY_LEN {
            return Err("must decode to exactly 32 bytes");
        }
        out.copy_from_slice(&decoded);
    }
    if out.iter().all(|&b| b == 0) {
        return Err("must not be all zeros");
    }
    Ok(out)
}

const fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Resolve a bootstrap credential's tenant from its token hash, via the narrow
/// SECURITY DEFINER resolver `platform_resolve_bootstrap_org` (migration 0038).
///
/// `auth_bootstrap_credentials` is FORCE RLS, so the app's non-owner `console_rt`
/// role cannot read a credential row by hash until `app.current_org` is armed —
/// but the org is exactly what we need to arm it. This resolver returns ONLY the
/// org_id (nothing else), breaking that chicken-and-egg without widening any read
/// surface. Returns `None` for an unknown hash.
pub(crate) async fn resolve_bootstrap_org(
    tx: &mut Transaction<'_, Postgres>,
    token_hash: &[u8],
) -> Result<Option<Uuid>, ProvisioningError> {
    Ok(
        sqlx::query_scalar("SELECT platform_resolve_bootstrap_org($1)")
            .bind(token_hash)
            .fetch_one(tx.as_mut())
            .await?,
    )
}

pub(crate) async fn resolve_otp_candidate_org(
    tx: &mut Transaction<'_, Postgres>,
    candidates: &[Vec<u8>],
) -> Result<Option<(Uuid, Vec<u8>)>, ProvisioningError> {
    for candidate in candidates {
        if let Some(org_uuid) = resolve_bootstrap_org(tx, candidate).await? {
            return Ok(Some((org_uuid, candidate.clone())));
        }
    }
    Ok(None)
}

pub(crate) async fn count_user_passkeys_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, ProvisioningError> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(tx.as_mut())
            .await?,
    )
}

/// Generate a uniformly random, phone-readable code grouped 5-5 using the OS CSPRNG.
pub(crate) fn generate_bootstrap_token() -> Result<BootstrapToken, ProvisioningError> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; OTP_LEN];
    rng.fill(&mut bytes).map_err(|_| {
        ProvisioningError::Conflict("CSPRNG unavailable for bootstrap token".to_owned())
    })?;
    let mut out = String::with_capacity(OTP_LEN + 1);
    for (index, &byte) in bytes.iter().enumerate() {
        if index == OTP_GROUP_LEN {
            out.push('-');
        }
        out.push(OTP_ALPHABET[usize::from(byte) % OTP_ALPHABET.len()] as char);
    }
    bytes.zeroize();
    Ok(BootstrapToken(SecretString::from(out)))
}

/// Generate a 256-bit high-entropy platform operator invite token (`cop_` + base64url).
pub(crate) fn generate_platform_invite_token() -> Result<BootstrapToken, ProvisioningError> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; PLATFORM_INVITE_RANDOM_BYTES];
    rng.fill(&mut bytes).map_err(|_| {
        ProvisioningError::Conflict("CSPRNG unavailable for invite token".to_owned())
    })?;
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    bytes.zeroize();
    let mut token = String::with_capacity(PLATFORM_INVITE_TOKEN_PREFIX.len() + encoded.len());
    token.push_str(PLATFORM_INVITE_TOKEN_PREFIX);
    token.push_str(&encoded);
    Ok(BootstrapToken(SecretString::from(token)))
}

fn hmac_otp_with_raw_key(raw_key: &[u8; OTP_HMAC_KEY_LEN], token: &str) -> Vec<u8> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, raw_key);
    let mut ctx = hmac::Context::with_key(&key);
    ctx.update(BOOTSTRAP_OTP_HASH_DOMAIN);
    ctx.update(token.as_bytes());
    ctx.sign().as_ref().to_vec()
}

pub(crate) fn hash_otp_v2(key: &OtpHmacKey, token: &str) -> Vec<u8> {
    hmac_otp_with_raw_key(key.active.expose_secret(), token)
}

pub(crate) fn hash_otp_v2_prev(key: &OtpHmacKey, token: &str) -> Option<Vec<u8>> {
    key.previous
        .as_ref()
        .map(|prev| hmac_otp_with_raw_key(prev.expose_secret(), token))
}

pub(crate) fn hash_otp_legacy_v1(token: &str) -> Vec<u8> {
    digest(&SHA256, token.as_bytes()).as_ref().to_vec()
}

pub(crate) fn canonical_otp(token: &str) -> Option<String> {
    let compact = token
        .chars()
        .filter(|symbol| !symbol.is_ascii_whitespace() && *symbol != '-')
        .collect::<String>()
        .to_ascii_uppercase();
    if compact.len() == OTP_LEN && compact.bytes().all(|byte| OTP_ALPHABET.contains(&byte)) {
        Some(format!(
            "{}-{}",
            &compact[..OTP_GROUP_LEN],
            &compact[OTP_GROUP_LEN..]
        ))
    } else {
        None
    }
}

pub(crate) fn otp_lookup_candidates(key: &OtpHmacKey, token: &str) -> Vec<Vec<u8>> {
    let canonical = canonical_otp(token).filter(|c| c != token);
    let mut out = Vec::with_capacity(6);
    let mut push_unique = |candidate: Vec<u8>| {
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    };
    push_unique(hash_otp_v2(key, token));
    if let Some(ref c) = canonical {
        push_unique(hash_otp_v2(key, c));
    }
    if let Some(prev) = hash_otp_v2_prev(key, token) {
        push_unique(prev);
        if let Some(ref c) = canonical
            && let Some(prev_c) = hash_otp_v2_prev(key, c)
        {
            push_unique(prev_c);
        }
    }
    push_unique(hash_otp_legacy_v1(token));
    if let Some(ref c) = canonical {
        push_unique(hash_otp_legacy_v1(c));
    }
    out
}

/// Domain-separated SHA-256 digest for platform operator invite tokens.
pub(crate) fn hash_platform_invite_token(token: &str) -> Vec<u8> {
    let mut ctx = DigestContext::new(&SHA256);
    ctx.update(PLATFORM_INVITE_HASH_DOMAIN);
    ctx.update(token.as_bytes());
    ctx.finish().as_ref().to_vec()
}

#[cfg(test)]
#[path = "token_tests.rs"]
mod tests;
