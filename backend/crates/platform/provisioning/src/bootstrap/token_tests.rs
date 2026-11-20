// SPDX-License-Identifier: LicenseRef-Proprietary

use super::*;
use aws_lc_rs::digest::{SHA256, digest};

#[test]
fn otp_alphabet_is_crockford_base32() {
    assert_eq!(OTP_ALPHABET, b"0123456789ABCDEFGHJKMNPQRSTVWXYZ");
}

#[test]
fn otp_has_at_least_fifty_bits_of_entropy() {
    assert!(OTP_ALPHABET.len().is_power_of_two());
    let symbols = generate_bootstrap_token()
        .unwrap()
        .as_str()
        .bytes()
        .filter(|symbol| *symbol != b'-')
        .count();
    assert!(OTP_ALPHABET.len().ilog2() as usize * symbols >= 50);
}

#[test]
fn otp_is_ten_symbols_in_two_readable_groups() {
    for _ in 0..128 {
        let token = generate_bootstrap_token().unwrap();
        let groups: Vec<_> = token.as_str().split('-').collect();
        assert_eq!(groups.len(), 2);
        assert!(groups.iter().all(|group| group.len() == 5));
        assert!(groups.iter().all(|group| {
            group
                .bytes()
                .all(|symbol| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&symbol))
        }));
    }
}

#[test]
fn otp_v2_hmac_is_keyed_domain_separated_and_case_sensitive_on_raw() {
    let key_a = OtpHmacKey::from_bytes([0x11; 32], None).unwrap();
    let key_b = OtpHmacKey::from_bytes([0x22; 32], None).unwrap();
    let legacy = "aB!9-_cD";
    assert_ne!(
        hash_otp_v2(&key_a, legacy),
        digest(&SHA256, legacy.as_bytes()).as_ref().to_vec()
    );
    assert_ne!(hash_otp_v2(&key_a, legacy), hash_otp_v2(&key_b, legacy));
    assert_ne!(
        hash_otp_v2(&key_a, legacy),
        hash_otp_v2(&key_a, &legacy.to_ascii_uppercase())
    );
}

#[test]
fn otp_hmac_key_parses_hex_and_base64_rejects_malformed_and_redacts_debug() {
    let hex_key = "11".repeat(32);
    let b64_key = BASE64_STANDARD.encode([0x11; 32]);
    let parsed_hex = OtpHmacKey::from_encoded(&hex_key, None).unwrap();
    let parsed_b64 = OtpHmacKey::from_encoded(&format!("  {b64_key}\n"), None).unwrap();
    assert_eq!(parsed_hex, parsed_b64);
    assert_eq!(format!("{parsed_hex:?}"), "OtpHmacKey([REDACTED])");

    for bad in [
        "",
        "   ",
        &"00".repeat(32),
        &BASE64_STANDARD.encode([0u8; 32]),
        &"11".repeat(31),
        &"11".repeat(33),
        "not-valid-key",
        &BASE64_STANDARD.encode([0x11; 31]),
    ] {
        assert!(OtpHmacKey::from_encoded(bad, None).is_err(), "{bad}");
    }
}

#[test]
fn served_pattern_comes_from_issuance_format() {
    let alphabet = String::from_utf8_lossy(OTP_ALPHABET);
    assert_eq!(
        bootstrap_otp_pattern(),
        format!("^[{alphabet}]{{5}}-[{alphabet}]{{5}}$")
    );
}

#[test]
fn platform_invite_token_is_256_bit_domain_separated_and_redacted() {
    let key = OtpHmacKey::from_bytes([0x33; 32], None).unwrap();
    let a = generate_platform_invite_token().unwrap();
    let b = generate_platform_invite_token().unwrap();
    assert_ne!(a, b);
    assert!(a.as_str().starts_with(PLATFORM_INVITE_TOKEN_PREFIX));
    // 32 bytes base64url no-pad = 43 chars + 4 char prefix = 47 chars.
    assert_eq!(a.as_str().len(), 47);
    assert_eq!(format!("{a:?}"), "BootstrapToken([REDACTED])");
    assert_ne!(
        hash_platform_invite_token(a.as_str()),
        hash_otp_v2(&key, a.as_str()),
        "platform invite hash must be domain-separated from bootstrap OTP HMAC"
    );
    assert_ne!(
        hash_platform_invite_token(a.as_str()),
        hash_otp_legacy_v1(a.as_str()),
        "platform invite hash must be domain-separated from raw token SHA-256"
    );
    assert_eq!(hash_platform_invite_token(a.as_str()).len(), 32);
}
