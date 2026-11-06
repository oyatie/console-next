// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use chacha20poly1305::aead::{AeadCore, OsRng};

fn binding() -> Aad<'static> {
    Aad {
        org_id: "tenant",
        account_id: "row",
        field: "secret",
    }
}

// The original v1 writer, generating synthetic legacy records at test time.
fn legacy_seal(plaintext: &[u8]) -> SealedCredential {
    let dek = XChaCha20Poly1305::generate_key(&mut OsRng);
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let dek_nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let aad = binding().encode();
    let ciphertext = XChaCha20Poly1305::new(&dek)
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .unwrap();
    let dek_wrapped = XChaCha20Poly1305::new(Key::from_slice(&[7; 32]))
        .encrypt(
            &dek_nonce,
            Payload {
                msg: &dek,
                aad: &aad,
            },
        )
        .unwrap();
    SealedCredential {
        ciphertext,
        nonce: nonce.to_vec(),
        dek_wrapped,
        dek_nonce: dek_nonce.to_vec(),
        key_version: 1,
    }
}

#[test]
fn original_v1_records_remain_readable_and_authenticate_every_field() {
    let cipher = EnvelopeCredentialCipher::from_key_bytes(&[7; 32]).unwrap();
    let legacy = legacy_seal(b"synthetic legacy secret");
    assert_eq!(
        cipher.open_bytes(&legacy, binding()).unwrap(),
        b"synthetic legacy secret"
    );
    for field in 0..4 {
        let mut bad = legacy.clone();
        let bytes = match field {
            0 => &mut bad.ciphertext,
            1 => &mut bad.nonce,
            2 => &mut bad.dek_wrapped,
            _ => &mut bad.dek_nonce,
        };
        bytes[0] ^= 1;
        assert!(matches!(
            cipher.decrypt(&bad, binding()),
            Err(CipherError::Decrypt)
        ));
    }
    let mut bad_aad = binding();
    bad_aad.field = "other";
    assert!(matches!(
        cipher.decrypt(&legacy, bad_aad),
        Err(CipherError::Decrypt)
    ));
    let modern = cipher
        .encrypt(&cipher.open_bytes(&legacy, binding()).unwrap(), binding())
        .unwrap();
    assert_eq!(modern.key_version, 2);
    assert_eq!(
        cipher.open_bytes(&modern, binding()).unwrap(),
        b"synthetic legacy secret"
    );
}

#[test]
fn version_downgrades_and_tag_changes_are_refused() {
    let cipher = EnvelopeCredentialCipher::from_key_bytes(&[7; 32]).unwrap();
    let mut sealed = cipher.encrypt(b"secret", binding()).unwrap();
    assert_eq!(sealed.key_version, 2);
    let last = sealed.ciphertext.len() - 1;
    sealed.ciphertext[last] ^= 1;
    assert!(matches!(
        cipher.decrypt(&sealed, binding()),
        Err(CipherError::Decrypt)
    ));
    sealed.ciphertext[last] ^= 1;
    sealed.key_version = 1;
    assert!(matches!(
        cipher.decrypt(&sealed, binding()),
        Err(CipherError::Decrypt)
    ));
    let mut old = legacy_seal(b"secret");
    old.key_version = 2;
    assert!(matches!(
        cipher.decrypt(&old, binding()),
        Err(CipherError::Decrypt)
    ));
}

fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn nist_cavp_aes256_gcm_known_answers_use_the_writer_path() {
    // NIST gcmtestvectors.zip / gcmEncryptExtIV256.rsp, Count 0 for each
    // PTlen/AADlen pair (0/0, 128/0, 128/128), IVlen 96, Taglen 128.
    // https://csrc.nist.gov/Projects/cryptographic-algorithm-validation-program/cavp-testing-block-cipher-modes
    for (key, iv, pt, aad, ct, tag) in [
        (
            "b52c505a37d78eda5dd34f20c22540ea1b58963cf8e5bf8ffa85f9f2492505b4",
            "516c33929df5a3284ff463d7",
            "",
            "",
            "",
            "bdc1ac884d332457a1d2664f168c76f0",
        ),
        (
            "31bdadd96698c204aa9ce1448ea94ae1fb4a9a0b3c9d773b51bb1822666b8f22",
            "0d18e06c7c725ac9e362e1ce",
            "2db5168e932556f8089a0622981d017d",
            "",
            "fa4362189661d163fcd6a56d8bf0405a",
            "d636ac1bbedd5cc3ee727dc2ab4a9489",
        ),
        (
            "92e11dcdaa866f5ce790fd24501f92509aacf4cb8b1339d50c9c1240935dd08b",
            "ac93a1a6145299bde902f21a",
            "2d71bcfa914e4ac045b2aa60955fad24",
            "1e0889016f67601c8ebea4943bc23ad6",
            "8995ae2e6df3dbf96fac7b7137bae67f",
            "eca5aa77d51d4a0a14d9c51e1da474ab",
        ),
    ] {
        let nonce = unhex(iv).try_into().unwrap();
        assert_eq!(
            gcm_seal(&unhex(key), nonce, &unhex(pt), &unhex(aad)).unwrap(),
            unhex(&format!("{ct}{tag}"))
        );
    }
}

#[test]
fn swapping_wrapped_deks_between_rows_is_refused() {
    let cipher = EnvelopeCredentialCipher::from_key_bytes(&[7; 32]).unwrap();
    let mut first = cipher.encrypt(b"first", binding()).unwrap();
    let second = cipher.encrypt(b"second", binding()).unwrap();
    first.dek_wrapped = second.dek_wrapped;
    assert!(matches!(
        cipher.decrypt(&first, binding()),
        Err(CipherError::Decrypt)
    ));
}

#[test]
fn malformed_v2_wraps_and_authenticated_wrong_size_deks_are_refused() {
    let cipher = EnvelopeCredentialCipher::from_key_bytes(&[7; 32]).unwrap();
    let original = cipher.encrypt(b"secret", binding()).unwrap();
    for size in [0, 1, 16, 39, 41, 48] {
        let mut sealed = original.clone();
        sealed.dek_wrapped.resize(size, 0);
        assert!(matches!(
            cipher.decrypt(&sealed, binding()),
            Err(CipherError::Decrypt)
        ));
    }
    let mut sealed = original;
    let kek = AesKek::new(&AES_256, &[7; 32]).unwrap();
    let mut output = [0u8; 40];
    sealed.dek_wrapped = kek
        .wrap_with_padding(&[0u8; 31], &mut output)
        .unwrap()
        .to_vec();
    assert!(matches!(
        cipher.decrypt(&sealed, binding()),
        Err(CipherError::Decrypt)
    ));
}

#[test]
fn v2_nonce_lengths_are_strict_even_for_a_zero_nonce_payload() {
    let key = [7u8; 32];
    let cipher = EnvelopeCredentialCipher::from_key_bytes(&key).unwrap();
    let kek = AesKek::new(&AES_256, &key).unwrap();
    let mut output = [0u8; 40];
    let mut sealed = SealedCredential {
        ciphertext: gcm_seal(&[0u8; 32], [0; 12], b"secret", &binding().encode()).unwrap(),
        nonce: vec![0; 12],
        dek_wrapped: kek
            .wrap_with_padding(&[0u8; 32], &mut output)
            .unwrap()
            .to_vec(),
        dek_nonce: Vec::new(),
        key_version: 2,
    };
    assert_eq!(cipher.open_bytes(&sealed, binding()).unwrap(), b"secret");
    for size in [0, 11, 13, 24] {
        sealed.nonce = vec![0; size];
        assert!(matches!(
            cipher.decrypt(&sealed, binding()),
            Err(CipherError::Decrypt)
        ));
    }
}
