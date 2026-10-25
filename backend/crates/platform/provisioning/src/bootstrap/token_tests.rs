// SPDX-License-Identifier: LicenseRef-Proprietary

use super::*;

#[test]
fn otp_alphabet_is_crockford_base32() {
    assert_eq!(OTP_ALPHABET, b"0123456789ABCDEFGHJKMNPQRSTVWXYZ");
}

#[test]
fn otp_has_at_least_fifty_bits_of_entropy() {
    assert!(OTP_ALPHABET.len().is_power_of_two());
    let symbols = generate_bootstrap_token()
        .as_str()
        .bytes()
        .filter(|symbol| *symbol != b'-')
        .count();
    assert!(OTP_ALPHABET.len().ilog2() as usize * symbols >= 50);
    // UUID byte six carries fixed version bits and must never enter the code.
    assert!(std::hint::black_box(OTP_GROUP_LEN) <= 6);
}

#[test]
fn otp_is_ten_symbols_in_two_readable_groups() {
    for _ in 0..128 {
        let token = generate_bootstrap_token();
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
fn legacy_hash_keeps_case_and_symbols() {
    let legacy = "aB!9-_cD";
    assert_eq!(
        hash_token(legacy),
        Sha256::digest(legacy.as_bytes()).to_vec()
    );
    assert_ne!(hash_token(legacy), hash_token(&legacy.to_ascii_uppercase()));
}

#[test]
fn served_pattern_comes_from_issuance_format() {
    let alphabet = String::from_utf8_lossy(OTP_ALPHABET);
    assert_eq!(
        bootstrap_otp_pattern(),
        format!("^[{alphabet}]{{5}}-[{alphabet}]{{5}}$")
    );
}
