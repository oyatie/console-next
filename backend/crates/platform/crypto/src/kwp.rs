// SPDX-License-Identifier: LicenseRef-Proprietary
//! HKDF-SHA256 domain-separated AES-256-KWP (RFC 5649 / NIST SP 800-38F) wrapping.

use aws_lc_rs::{
    hkdf,
    key_wrap::{AES_256, AesKek, KeyWrapPadded},
};
use secrecy::{ExposeSecret, SecretBox};
use zeroize::Zeroizing;

use crate::aad::push_lp_u32;
use crate::error::CryptoError;
use crate::header::KekId;

const KWP_SALT: &[u8] = b"console.crypto.kwp.salt.v1";
const KWP_INFO_DOMAIN: &[u8] = b"console.crypto.kwp.v1";
const DEK_LEN: usize = 32;
const KWP_OUT_BUF_LEN: usize = 48;

pub(crate) struct KeyLen(pub(crate) usize);

impl hkdf::KeyType for KeyLen {
    fn len(&self) -> usize {
        self.0
    }
}

fn derive_wrap_kek(
    master_kek: &SecretBox<[u8; 32]>,
    kek_id: &KekId,
    purpose: &str,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if purpose.is_empty() {
        return Err(CryptoError::InvalidInput);
    }
    let mut info =
        Vec::with_capacity(KWP_INFO_DOMAIN.len() + 8 + kek_id.as_bytes().len() + purpose.len());
    info.extend_from_slice(KWP_INFO_DOMAIN);
    push_lp_u32(&mut info, kek_id.as_bytes())?;
    push_lp_u32(&mut info, purpose.as_bytes())?;

    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, KWP_SALT);
    let prk = salt.extract(master_kek.expose_secret());
    let slices = [info.as_slice()];
    let okm = prk
        .expand(&slices, KeyLen(DEK_LEN))
        .map_err(|_| CryptoError::Encrypt)?;
    let mut out = Zeroizing::new([0u8; DEK_LEN]);
    okm.fill(out.as_mut()).map_err(|_| CryptoError::Encrypt)?;
    Ok(out)
}

/// Derive a domain-separated 256-bit wrapping key and wrap `dek` with AES-256-KWP.
pub fn wrap_dek_kwp(
    master_kek: &SecretBox<[u8; 32]>,
    kek_id: &KekId,
    purpose: &str,
    dek: &SecretBox<[u8; 32]>,
) -> Result<Vec<u8>, CryptoError> {
    let wrap_kek = derive_wrap_kek(master_kek, kek_id, purpose)?;
    let aes_kek = AesKek::new(&AES_256, wrap_kek.as_ref()).map_err(|_| CryptoError::Encrypt)?;
    let mut out_buf = Zeroizing::new([0u8; KWP_OUT_BUF_LEN]);
    let wrapped = aes_kek
        .wrap_with_padding(dek.expose_secret(), out_buf.as_mut())
        .map_err(|_| CryptoError::Encrypt)?;
    Ok(wrapped.to_vec())
}

/// Derive a domain-separated 256-bit wrapping key and unwrap `wrapped_dek` with AES-256-KWP.
pub fn unwrap_dek_kwp(
    master_kek: &SecretBox<[u8; 32]>,
    kek_id: &KekId,
    purpose: &str,
    wrapped_dek: &[u8],
) -> Result<SecretBox<[u8; 32]>, CryptoError> {
    if wrapped_dek.len() < 16 || wrapped_dek.len() > KWP_OUT_BUF_LEN {
        return Err(CryptoError::Decrypt);
    }
    let wrap_kek =
        derive_wrap_kek(master_kek, kek_id, purpose).map_err(|_| CryptoError::Decrypt)?;
    let aes_kek = AesKek::new(&AES_256, wrap_kek.as_ref()).map_err(|_| CryptoError::Decrypt)?;
    let mut out_buf = Zeroizing::new([0u8; KWP_OUT_BUF_LEN]);
    let unwrapped = aes_kek
        .unwrap_with_padding(wrapped_dek, out_buf.as_mut())
        .map_err(|_| CryptoError::Decrypt)?;
    let mut dek = Zeroizing::new([0u8; DEK_LEN]);
    if unwrapped.len() != DEK_LEN {
        return Err(CryptoError::Decrypt);
    }
    dek.copy_from_slice(unwrapped);
    Ok(SecretBox::new(Box::new(*dek)))
}
