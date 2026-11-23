// SPDX-License-Identifier: LicenseRef-Proprietary
//! AWS-ESDK-v2 key-committing AEAD envelope (`AlgId = 3`):
//! HKDF-SHA256 per-message enc_key + 256-bit commitment tag + AES-256-GCM
//! + constant-time commitment check before decryption + full outer AAD.

use aws_lc_rs::{
    aead,
    constant_time::verify_slices_are_equal,
    hkdf,
    rand::{SecureRandom, SystemRandom},
};
use secrecy::{ExposeSecret, SecretBox};
use zeroize::Zeroizing;

use crate::aad::{EnvelopeContext, encode_outer_aad};
use crate::error::CryptoError;
use crate::header::{EnvelopeHeader, SealedEnvelope};
use crate::kms::KmsProvider;
use crate::kwp::KeyLen;
use crate::suite::AlgId;

pub const DEK_LEN: usize = 32;
pub const MSG_ID_LEN: usize = 32;
pub const COMMITMENT_TAG_LEN: usize = 32;
pub const NONCE_LEN: usize = aead::NONCE_LEN;

const ENC_KEY_INFO: &[u8] = b"console.crypto.esdk.enc_key.v1";
const COMMIT_TAG_INFO: &[u8] = b"console.crypto.esdk.commit_key.v1";

fn derive_enc_and_commit(
    dek: &SecretBox<[u8; DEK_LEN]>,
    msg_id: &[u8; MSG_ID_LEN],
    alg_id: AlgId,
) -> Result<(Zeroizing<[u8; DEK_LEN]>, [u8; COMMITMENT_TAG_LEN]), CryptoError> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, msg_id);
    let prk = salt.extract(dek.expose_secret());
    let alg_be = alg_id.as_u16().to_be_bytes();

    let mut enc_key = Zeroizing::new([0u8; DEK_LEN]);
    let enc_info = [ENC_KEY_INFO, &alg_be];
    prk.expand(&enc_info, &aead::AES_256_GCM)
        .map_err(|_| CryptoError::Encrypt)?
        .fill(enc_key.as_mut())
        .map_err(|_| CryptoError::Encrypt)?;

    let mut commitment_tag = [0u8; COMMITMENT_TAG_LEN];
    let commit_info = [COMMIT_TAG_INFO, &alg_be];
    prk.expand(&commit_info, KeyLen(COMMITMENT_TAG_LEN))
        .map_err(|_| CryptoError::Encrypt)?
        .fill(&mut commitment_tag)
        .map_err(|_| CryptoError::Encrypt)?;

    Ok((enc_key, commitment_tag))
}

/// Seal `plaintext` using `alg_id = 3` AWS-ESDK-v2 key-committing AEAD.
pub fn seal_v3(
    kms: &dyn KmsProvider,
    ctx: EnvelopeContext<'_>,
    plaintext: &[u8],
) -> Result<SealedEnvelope, CryptoError> {
    let alg_id = AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap;
    let rng = SystemRandom::new();

    let mut raw_dek = Zeroizing::new([0u8; DEK_LEN]);
    rng.fill(raw_dek.as_mut())
        .map_err(|_| CryptoError::Encrypt)?;
    let dek = SecretBox::new(Box::new(*raw_dek));

    let mut msg_id = [0u8; MSG_ID_LEN];
    rng.fill(&mut msg_id).map_err(|_| CryptoError::Encrypt)?;

    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce).map_err(|_| CryptoError::Encrypt)?;

    let wrapped = kms.wrap_dek(ctx.purpose, &dek)?;
    let (enc_key, commitment_tag) = derive_enc_and_commit(&dek, &msg_id, alg_id)?;
    let outer_aad = encode_outer_aad(
        alg_id,
        &wrapped.kek_id,
        &wrapped.ciphertext,
        &msg_id,
        &commitment_tag,
        ctx,
    )?;

    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, enc_key.as_ref())
        .map_err(|_| CryptoError::Encrypt)?;
    let mut buf = Zeroizing::new(plaintext.to_vec());
    aead::LessSafeKey::new(unbound)
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(&outer_aad),
            &mut *buf,
        )
        .map_err(|_| CryptoError::Encrypt)?;

    Ok(SealedEnvelope {
        header: EnvelopeHeader {
            wire_version: 1,
            alg_id,
            kek_id: wrapped.kek_id,
            msg_id,
            commitment_tag,
            nonce,
            wrapped_dek: wrapped.ciphertext,
        },
        ciphertext: core::mem::take(&mut *buf),
    })
}

/// Open and authenticate an `alg_id = 3` AWS-ESDK-v2 key-committing envelope.
pub fn open_v3(
    kms: &dyn KmsProvider,
    ctx: EnvelopeContext<'_>,
    sealed: &SealedEnvelope,
) -> Result<SecretBox<Vec<u8>>, CryptoError> {
    if sealed.header.alg_id != AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap {
        return Err(CryptoError::UnsupportedAlgorithm);
    }
    if sealed.header.wire_version != 1 || sealed.ciphertext.len() < aead::AES_256_GCM.tag_len() {
        return Err(CryptoError::Decrypt);
    }

    let dek = match kms.unwrap_dek(
        &sealed.header.kek_id,
        ctx.purpose,
        &sealed.header.wrapped_dek,
    ) {
        Ok(dek) => dek,
        Err(CryptoError::ProviderUnavailable) => return Err(CryptoError::ProviderUnavailable),
        Err(_) => return Err(CryptoError::Decrypt),
    };

    let (enc_key, expected_commit_tag) =
        derive_enc_and_commit(&dek, &sealed.header.msg_id, sealed.header.alg_id)
            .map_err(|_| CryptoError::Decrypt)?;

    // Key commitment MUST be verified in constant time BEFORE AES-256-GCM decryption.
    verify_slices_are_equal(&expected_commit_tag, &sealed.header.commitment_tag)
        .map_err(|_| CryptoError::Decrypt)?;

    let outer_aad = encode_outer_aad(
        sealed.header.alg_id,
        &sealed.header.kek_id,
        &sealed.header.wrapped_dek,
        &sealed.header.msg_id,
        &sealed.header.commitment_tag,
        ctx,
    )
    .map_err(|_| CryptoError::Decrypt)?;

    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, enc_key.as_ref())
        .map_err(|_| CryptoError::Decrypt)?;
    let mut plaintext_buf = Zeroizing::new(sealed.ciphertext.clone());
    let plain_len = aead::LessSafeKey::new(unbound)
        .open_in_place(
            aead::Nonce::assume_unique_for_key(sealed.header.nonce),
            aead::Aad::from(&outer_aad),
            &mut plaintext_buf,
        )
        .map_err(|_| CryptoError::Decrypt)?
        .len();
    plaintext_buf.truncate(plain_len);
    Ok(SecretBox::new(Box::new(core::mem::take(
        &mut *plaintext_buf,
    ))))
}
