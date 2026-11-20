// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

fn test_key_b64() -> String {
    BASE64.encode([7u8; KEY_LEN])
}

fn cipher() -> EnvelopeCredentialCipher {
    EnvelopeCredentialCipher::from_owned_base64_key(test_key_b64()).unwrap()
}

fn aad<'a>() -> Aad<'a> {
    Aad {
        org_id: "11111111-1111-1111-1111-111111111111",
        account_id: "22222222-2222-2222-2222-222222222222",
        field: "smtp_password",
    }
}

#[test]
fn round_trip_recovers_plaintext() {
    let c = cipher();
    let secret = b"super-secret-smtp-pw";
    let sealed = c.encrypt(secret, aad()).unwrap();
    let out = c.decrypt(&sealed, aad()).unwrap();
    assert_eq!(out.expose_secret().as_slice(), secret);
}

#[test]
fn ciphertext_is_not_plaintext_and_v2_has_gcm_nonce() {
    let c = cipher();
    let secret = b"another-pw";
    let sealed = c.encrypt_with_suite(2, secret, aad()).unwrap();
    assert_ne!(sealed.ciphertext, secret);
    assert_eq!(sealed.nonce.len(), 12);
    assert!(sealed.dek_nonce.is_empty());
    assert_eq!(sealed.key_version, 2);
    assert_eq!(sealed.dek_wrapped.len(), KEY_LEN + 8);
}

#[test]
fn fresh_dek_and_nonce_per_call_yield_distinct_ciphertext() {
    let c = cipher();
    let secret = b"same-input";
    let a = c.encrypt(secret, aad()).unwrap();
    let b = c.encrypt(secret, aad()).unwrap();
    assert_ne!(a.ciphertext, b.ciphertext);
    assert_ne!(a.nonce, b.nonce);
    assert_ne!(a.dek_wrapped, b.dek_wrapped);
    assert_eq!(
        c.decrypt(&a, aad()).unwrap().expose_secret().as_slice(),
        secret
    );
    assert_eq!(
        c.decrypt(&b, aad()).unwrap().expose_secret().as_slice(),
        secret
    );
}

#[test]
fn wrong_kek_fails_to_decrypt() {
    let c = cipher();
    let sealed = c.encrypt(b"pw", aad()).unwrap();
    let other = EnvelopeCredentialCipher::from_key_bytes(&[9u8; KEY_LEN]).unwrap();
    assert!(matches!(
        other.decrypt(&sealed, aad()),
        Err(CipherError::Decrypt)
    ));
}

#[test]
fn tampered_fields_fail_auth() {
    let c = cipher();
    let mut sealed = c.encrypt(b"pw", aad()).unwrap();
    sealed.ciphertext[0] ^= 0xff;
    assert!(matches!(
        c.decrypt(&sealed, aad()),
        Err(CipherError::Decrypt)
    ));
    sealed.ciphertext[0] ^= 0xff;
    sealed.nonce[0] ^= 0xff;
    assert!(matches!(
        c.decrypt(&sealed, aad()),
        Err(CipherError::Decrypt)
    ));
    sealed.nonce[0] ^= 0xff;
    sealed.dek_wrapped[0] ^= 0xff;
    assert!(matches!(
        c.decrypt(&sealed, aad()),
        Err(CipherError::Decrypt)
    ));
    sealed.dek_wrapped[0] ^= 0xff;
    sealed.dek_nonce.push(0xff);
    assert!(matches!(
        c.decrypt(&sealed, aad()),
        Err(CipherError::Decrypt)
    ));
}

#[test]
fn wrong_aad_and_key_version_fail() {
    let c = cipher();
    let mut sealed = c.encrypt(b"pw", aad()).unwrap();
    for bad in [
        Aad {
            org_id: "99999999-9999-9999-9999-999999999999",
            ..aad()
        },
        Aad {
            account_id: "00000000-0000-0000-0000-000000000000",
            ..aad()
        },
        Aad {
            field: "imap_password",
            ..aad()
        },
    ] {
        assert!(matches!(c.decrypt(&sealed, bad), Err(CipherError::Decrypt)));
    }
    sealed.key_version = 99;
    assert!(matches!(
        c.decrypt(&sealed, aad()),
        Err(CipherError::KeyVersion)
    ));
}

#[test]
fn bad_master_key_inputs_are_rejected() {
    assert!(matches!(
        EnvelopeCredentialCipher::from_base64_key("not!base64!"),
        Err(CipherError::MasterKey)
    ));
    let short = BASE64.encode([1u8; 16]);
    assert!(matches!(
        EnvelopeCredentialCipher::from_base64_key(&short),
        Err(CipherError::MasterKey)
    ));
    assert!(matches!(
        EnvelopeCredentialCipher::from_key_bytes(&[0u8; 31]),
        Err(CipherError::MasterKey)
    ));
}

#[test]
fn secret_debug_is_redacted_and_empty_plaintext_round_trips() {
    let c = cipher();
    let sealed = c.encrypt(b"top-secret-value", aad()).unwrap();
    let recovered = c.decrypt(&sealed, aad()).unwrap();
    let dbg = format!("{recovered:?}");
    assert!(dbg.contains("REDACTED"));
    assert!(!dbg.contains("top-secret-value"));
    let empty = c.encrypt(b"", aad()).unwrap();
    assert!(c.decrypt(&empty, aad()).unwrap().expose_secret().is_empty());
}

#[test]
fn every_seal_draws_fresh_nonces() {
    let cipher = EnvelopeCredentialCipher::from_key_bytes(&[7u8; 32]).unwrap();
    for suite in [1, 2, 3] {
        let a = cipher.encrypt_with_suite(suite, b"secret", aad()).unwrap();
        let b = cipher.encrypt_with_suite(suite, b"secret", aad()).unwrap();
        assert_ne!(a.nonce, b.nonce, "suite {suite} reused a nonce");
        assert!(
            a.nonce.iter().any(|&x| x != 0),
            "suite {suite} sealed with a zero nonce"
        );
        if suite == 1 {
            assert_ne!(a.dek_nonce, b.dek_nonce, "suite 1 reused a DEK nonce");
        }
    }
}

#[test]
fn aad_encoding_is_unambiguous() {
    // Length-prefixing keeps ("ab","c") distinct from ("a","bc").
    let one = Aad {
        org_id: "ab",
        account_id: "c",
        field: "f",
    }
    .encode();
    let two = Aad {
        org_id: "a",
        account_id: "bc",
        field: "f",
    }
    .encode();
    assert_ne!(one, two);
}

#[test]
fn wrong_nonce_length_is_rejected() {
    let c = cipher();
    let mut sealed = c.encrypt(b"pw", aad()).unwrap();
    sealed.nonce.truncate(11);
    assert!(matches!(
        c.decrypt(&sealed, aad()),
        Err(CipherError::Decrypt)
    ));
}
