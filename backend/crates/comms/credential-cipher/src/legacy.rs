// SPDX-License-Identifier: LicenseRef-Proprietary
//! Legacy v1 (XChaCha20-Poly1305) and v2 (AES-256-GCM + raw AES-256-KWP)
//! envelope helpers retained for N-1 dual-read and rollout-safe v1 writes.

use aws_lc_rs::{
    aead,
    key_wrap::{AES_256, AesKek, KeyWrapPadded},
    rand::{SecureRandom, SystemRandom},
};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use console_comms_application::credential_cipher::{Aad, CipherError, SealedCredential};
use console_platform_crypto::{AlgId, KekId, LocalKeyringProvider};
use secrecy::{ExposeSecret, SecretBox};
use zeroize::Zeroizing;

pub(crate) const KEY_LEN: usize = 32;

pub(crate) fn encrypt_v1(
    ring: &LocalKeyringProvider,
    plaintext: &[u8],
    aad: Aad<'_>,
) -> Result<SealedCredential, CipherError> {
    let active_id = console_platform_crypto::KmsProvider::active_kek_id(ring);
    let master_kek = ring.get_key(active_id).ok_or(CipherError::MasterKey)?;

    let rng = SystemRandom::new();
    let mut dek = Zeroizing::new([0u8; KEY_LEN]);
    rng.fill(dek.as_mut()).map_err(|_| CipherError::Encrypt)?;
    let nonce: [u8; 24] = random(&rng)?;
    let dek_nonce: [u8; 24] = random(&rng)?;
    let aad_bytes = aad.encode();
    let ciphertext = XChaCha20Poly1305::new(Key::from_slice(dek.as_ref()))
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad_bytes,
            },
        )
        .map_err(|_| CipherError::Encrypt)?;
    let kek_cipher = XChaCha20Poly1305::new(Key::from_slice(master_kek.expose_secret().as_slice()));
    let dek_wrapped = kek_cipher
        .encrypt(
            XNonce::from_slice(&dek_nonce),
            Payload {
                msg: dek.as_ref(),
                aad: &aad_bytes,
            },
        )
        .map_err(|_| CipherError::Encrypt)?;
    Ok(SealedCredential {
        ciphertext,
        nonce: nonce.to_vec(),
        dek_wrapped,
        dek_nonce: dek_nonce.to_vec(),
        key_version: 1,
        alg_id: None,
        kek_id: None,
        msg_id: None,
        commitment_tag: None,
    })
}

pub(crate) fn encrypt_v2(
    ring: &LocalKeyringProvider,
    plaintext: &[u8],
    aad: Aad<'_>,
) -> Result<SealedCredential, CipherError> {
    let active_id = console_platform_crypto::KmsProvider::active_kek_id(ring);
    let master_kek = ring.get_key(active_id).ok_or(CipherError::MasterKey)?;

    let rng = SystemRandom::new();
    let mut dek = Zeroizing::new([0u8; KEY_LEN]);
    rng.fill(dek.as_mut()).map_err(|_| CipherError::Encrypt)?;
    let nonce: [u8; aead::NONCE_LEN] = random(&rng)?;
    let ciphertext = gcm_seal(dek.as_ref(), nonce, plaintext, &aad.encode())?;
    let kek =
        AesKek::new(&AES_256, master_kek.expose_secret()).map_err(|_| CipherError::Encrypt)?;
    let mut wrapped = [0u8; KEY_LEN + 8];
    let dek_wrapped = kek
        .wrap_with_padding(dek.as_ref(), &mut wrapped)
        .map_err(|_| CipherError::Encrypt)?
        .to_vec();
    Ok(SealedCredential {
        ciphertext,
        nonce: nonce.to_vec(),
        dek_wrapped,
        dek_nonce: Vec::new(),
        key_version: 2,
        alg_id: None,
        kek_id: None,
        msg_id: None,
        commitment_tag: None,
    })
}

pub(crate) fn decrypt_v1(
    ring: &LocalKeyringProvider,
    sealed: &SealedCredential,
    aad: Aad<'_>,
) -> Result<SecretBox<Vec<u8>>, CipherError> {
    if let Some(alg) = &sealed.alg_id
        && alg != AlgId::LegacyXChaCha20Poly1305.as_str()
    {
        return Err(CipherError::Decrypt);
    }
    let aad_bytes = aad.encode();
    let dek_nonce = nonce_from_slice(&sealed.dek_nonce)?;
    let nonce = nonce_from_slice(&sealed.nonce)?;

    if let Some(raw_id) = &sealed.kek_id {
        let kek_id = KekId::new(raw_id.as_str()).map_err(|_| CipherError::Decrypt)?;
        let kek = ring.get_key(&kek_id).ok_or(CipherError::Decrypt)?;
        return decrypt_v1_with_kek(kek, sealed, &aad_bytes, &dek_nonce, &nonce);
    }

    let legacy_id = KekId::legacy_default();
    if let Some(kek) = ring.get_key(&legacy_id)
        && let Ok(pt) = decrypt_v1_with_kek(kek, sealed, &aad_bytes, &dek_nonce, &nonce)
    {
        return Ok(pt);
    }
    for (id, kek) in ring.iter_keys() {
        if *id == legacy_id {
            continue;
        }
        if let Ok(pt) = decrypt_v1_with_kek(kek, sealed, &aad_bytes, &dek_nonce, &nonce) {
            return Ok(pt);
        }
    }
    Err(CipherError::Decrypt)
}

pub(crate) fn decrypt_v2(
    ring: &LocalKeyringProvider,
    sealed: &SealedCredential,
    aad: Aad<'_>,
) -> Result<SecretBox<Vec<u8>>, CipherError> {
    if let Some(alg) = &sealed.alg_id
        && alg != AlgId::LegacyAes256GcmKwp.as_str()
    {
        return Err(CipherError::Decrypt);
    }
    if !sealed.dek_nonce.is_empty() {
        return Err(CipherError::Decrypt);
    }
    let nonce: [u8; aead::NONCE_LEN] = sealed
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| CipherError::Decrypt)?;
    let aad_bytes = aad.encode();

    if let Some(raw_id) = &sealed.kek_id {
        let kek_id = KekId::new(raw_id.as_str()).map_err(|_| CipherError::Decrypt)?;
        let kek = ring.get_key(&kek_id).ok_or(CipherError::Decrypt)?;
        return decrypt_v2_with_kek(kek, sealed, nonce, &aad_bytes);
    }

    let legacy_id = KekId::legacy_default();
    if let Some(kek) = ring.get_key(&legacy_id)
        && let Ok(pt) = decrypt_v2_with_kek(kek, sealed, nonce, &aad_bytes)
    {
        return Ok(pt);
    }
    for (id, kek) in ring.iter_keys() {
        if *id == legacy_id {
            continue;
        }
        if let Ok(pt) = decrypt_v2_with_kek(kek, sealed, nonce, &aad_bytes) {
            return Ok(pt);
        }
    }
    Err(CipherError::Decrypt)
}

fn decrypt_v1_with_kek(
    master_kek: &SecretBox<[u8; KEY_LEN]>,
    sealed: &SealedCredential,
    aad_bytes: &[u8],
    dek_nonce: &XNonce,
    nonce: &XNonce,
) -> Result<SecretBox<Vec<u8>>, CipherError> {
    let kek_cipher = XChaCha20Poly1305::new(Key::from_slice(master_kek.expose_secret().as_slice()));
    let dek_bytes = Zeroizing::new(
        kek_cipher
            .decrypt(
                dek_nonce,
                Payload {
                    msg: &sealed.dek_wrapped,
                    aad: aad_bytes,
                },
            )
            .map_err(|_| CipherError::Decrypt)?,
    );
    if dek_bytes.len() != KEY_LEN {
        return Err(CipherError::Decrypt);
    }
    let dek_cipher = XChaCha20Poly1305::new(Key::from_slice(&dek_bytes));
    let mut plaintext = Zeroizing::new(
        dek_cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &sealed.ciphertext,
                    aad: aad_bytes,
                },
            )
            .map_err(|_| CipherError::Decrypt)?,
    );
    Ok(SecretBox::new(Box::new(std::mem::take(&mut *plaintext))))
}

fn decrypt_v2_with_kek(
    master_kek: &SecretBox<[u8; KEY_LEN]>,
    sealed: &SealedCredential,
    nonce: [u8; aead::NONCE_LEN],
    aad_bytes: &[u8],
) -> Result<SecretBox<Vec<u8>>, CipherError> {
    let kek =
        AesKek::new(&AES_256, master_kek.expose_secret()).map_err(|_| CipherError::Decrypt)?;
    let mut dek = Zeroizing::new([0u8; KEY_LEN + 8]);
    let key = kek
        .unwrap_with_padding(&sealed.dek_wrapped, dek.as_mut())
        .map_err(|_| CipherError::Decrypt)?;
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| CipherError::Decrypt)?;
    let mut plaintext = Zeroizing::new(sealed.ciphertext.clone());
    let len = aead::LessSafeKey::new(key)
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad_bytes),
            &mut plaintext,
        )
        .map_err(|_| CipherError::Decrypt)?
        .len();
    plaintext.truncate(len);
    Ok(SecretBox::new(Box::new(std::mem::take(&mut *plaintext))))
}

pub(crate) fn gcm_seal(
    key: &[u8],
    nonce: [u8; aead::NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CipherError> {
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| CipherError::Encrypt)?;
    let mut ciphertext = Zeroizing::new(plaintext.to_vec());
    aead::LessSafeKey::new(key)
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad),
            &mut *ciphertext,
        )
        .map_err(|_| CipherError::Encrypt)?;
    Ok(std::mem::take(&mut *ciphertext))
}

fn random<const N: usize>(rng: &SystemRandom) -> Result<[u8; N], CipherError> {
    aws_lc_rs::rand::generate(rng)
        .map(|r| r.expose())
        .map_err(|_| CipherError::Encrypt)
}

fn nonce_from_slice(bytes: &[u8]) -> Result<XNonce, CipherError> {
    if bytes.len() != 24 {
        return Err(CipherError::Decrypt);
    }
    Ok(*XNonce::from_slice(bytes))
}
