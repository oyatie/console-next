// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use aws_lc_rs::hmac;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_platform_crypto::{
    BlindIndexContext, BlindIndexKeyring, CryptoError, DEFAULT_TENANT_BLIND_INDEX_VERSION,
    LEGACY_HMAC_KEY_VERSION,
};
use secrecy::SecretString;
use uuid::Uuid;
use zeroize::Zeroizing;

fn ctx<'a>(org_id: Uuid, table: &'a str, field: &'a str) -> BlindIndexContext<'a> {
    BlindIndexContext {
        org_id,
        table,
        field,
    }
}

#[test]
fn single_legacy_key_registers_v1_and_v2_with_v2_active_and_rfc4231_parity() {
    let key_b64 = BASE64.encode([0x11u8; 32]);
    let ring = BlindIndexKeyring::from_single_legacy_base64(&key_b64).unwrap();
    assert_eq!(ring.active_version(), DEFAULT_TENANT_BLIND_INDEX_VERSION);
    let versions: Vec<i16> = ring.versions().collect();
    assert_eq!(versions, vec![1, 2]);

    let org_a = Uuid::new_v4();
    let org_b = Uuid::new_v4();
    let msg = b"9001011234567";

    // v1 matches raw HMAC-SHA256 byte-for-byte regardless of org_id
    let raw_expected = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, &[0x11u8; 32]), msg);
    let v1_a = ring
        .compute_for_version(
            LEGACY_HMAC_KEY_VERSION,
            ctx(org_a, "employee_rrn", "rrn"),
            msg,
        )
        .unwrap();
    let v1_b = ring
        .compute_for_version(
            LEGACY_HMAC_KEY_VERSION,
            ctx(org_b, "employee_rrn", "rrn"),
            msg,
        )
        .unwrap();
    assert_eq!(v1_a.as_slice(), raw_expected.as_ref());
    assert_eq!(v1_a, v1_b);

    // v2 is tenant-bound and distinct from v1
    let (active_ver, v2_a) = ring
        .compute_active(ctx(org_a, "employee_rrn", "rrn"), msg)
        .unwrap();
    let v2_b = ring
        .compute_for_version(2, ctx(org_b, "employee_rrn", "rrn"), msg)
        .unwrap();
    assert_eq!(active_ver, 2);
    assert_ne!(v2_a, v1_a);
    assert_ne!(v2_a, v2_b);
}

#[test]
fn context_domain_and_length_prefix_framing_separate_all_fields() {
    let key_b64 = BASE64.encode([0x22u8; 32]);
    let ring = BlindIndexKeyring::from_single_legacy_base64(&key_b64).unwrap();
    let org = Uuid::new_v4();
    let msg = b"9001011234567";

    let base = ring
        .compute_for_version(2, ctx(org, "employee_rrn", "rrn"), msg)
        .unwrap();
    let diff_table = ring
        .compute_for_version(2, ctx(org, "other_table", "rrn"), msg)
        .unwrap();
    let diff_field = ring
        .compute_for_version(2, ctx(org, "employee_rrn", "alt_rrn"), msg)
        .unwrap();
    assert_ne!(base, diff_table);
    assert_ne!(base, diff_field);

    // Length-prefix framing prevents boundary collisions ("ab","c") vs ("a","bc")
    let ab_c = ring
        .compute_for_version(2, ctx(org, "ab", "c"), msg)
        .unwrap();
    let a_bc = ring
        .compute_for_version(2, ctx(org, "a", "bc"), msg)
        .unwrap();
    assert_ne!(ab_c, a_bc);

    // Empty table or field fails closed
    assert_eq!(
        ring.compute_for_version(2, ctx(org, "", "rrn"), msg)
            .unwrap_err(),
        CryptoError::InvalidInput
    );
    assert_eq!(
        ring.compute_for_version(2, ctx(org, "employee_rrn", ""), msg)
            .unwrap_err(),
        CryptoError::InvalidInput
    );
}

#[test]
fn multi_version_keyring_rotation_candidates_and_debug_redaction() {
    let k1 = BASE64.encode([0x01u8; 32]);
    let k2 = BASE64.encode([0x02u8; 32]);
    let k3 = BASE64.encode([0x03u8; 32]);
    let json = format!(r#"{{"active":3,"keys":{{"1":"{k1}","2":"{k2}","3":"{k3}"}}}}"#);
    let ring = BlindIndexKeyring::from_keyring_json(&json).unwrap();
    assert_eq!(ring.active_version(), 3);

    let org = Uuid::new_v4();
    let c = ctx(org, "employee_rrn", "rrn");
    let msg = b"9001011234567";

    let v2_cand = ring.compute_v2_candidates(c, msg).unwrap();
    assert_eq!(v2_cand.len(), 2);
    assert_eq!(v2_cand[0].0, 3);
    assert_eq!(v2_cand[1].0, 2);
    assert_ne!(v2_cand[0].1, v2_cand[1].1);

    let all_cand = ring.compute_all_candidates(c, msg).unwrap();
    assert_eq!(
        all_cand.iter().map(|(v, _)| *v).collect::<Vec<_>>(),
        vec![3, 2, 1]
    );

    // Redacted Debug never leaks base64 keys
    let dbg = format!("{ring:?}");
    assert!(dbg.contains("REDACTED"));
    assert!(dbg.contains("active_version: 3"));
    assert!(!dbg.contains(&k1));
    assert!(!dbg.contains(&k2));
    assert!(!dbg.contains(&k3));
}

#[test]
fn env_merge_rejects_mismatched_v1_and_invalid_json_fails_closed() {
    let k1 = BASE64.encode([0x41u8; 32]);
    let k2 = BASE64.encode([0x42u8; 32]);
    let k_conflict = BASE64.encode([0x43u8; 32]);

    // Merge legacy v1 when keyring omits v1
    let merged = BlindIndexKeyring::from_env_values(
        Some(Zeroizing::new(format!(
            r#"{{"active":2,"keys":{{"2":"{k2}"}}}}"#
        ))),
        Some(Zeroizing::new(k1.clone())),
    )
    .unwrap()
    .unwrap();
    assert!(merged.has_version(1));
    assert!(merged.has_version(2));

    // Matching v1 succeeds
    assert!(
        BlindIndexKeyring::from_env_values(
            Some(Zeroizing::new(format!(
                r#"{{"active":2,"keys":{{"1":"{k1}","2":"{k2}"}}}}"#
            ))),
            Some(Zeroizing::new(k1.clone())),
        )
        .is_ok()
    );

    // Mismatched v1 fails closed with InvalidKeyMaterial
    assert_eq!(
        BlindIndexKeyring::from_env_values(
            Some(Zeroizing::new(format!(
                r#"{{"active":2,"keys":{{"1":"{k_conflict}","2":"{k2}"}}}}"#
            ))),
            Some(Zeroizing::new(k1.clone())),
        )
        .unwrap_err(),
        CryptoError::InvalidKeyMaterial
    );

    // Malformed payloads fail closed
    for bad in [
        "{}",
        r#"{"active":0,"keys":{"0":""}}"#,
        r#"{"active":2,"keys":{"1":"bad"}}"#,
        &format!(r#"{{"active":2,"keys":{{"1":"{k1}"}}}}"#),
        &format!(r#"{{"active":2,"keys":{{"02":"{k2}"}}}}"#),
        &format!(r#"{{"active":2,"keys":{{"2":"{k2}"}},"extra":true}}"#),
    ] {
        assert_eq!(
            BlindIndexKeyring::from_keyring_json(bad).unwrap_err(),
            CryptoError::InvalidKeyMaterial
        );
    }

    let loaded = BlindIndexKeyring::from_env_vars("KR", "LEG", |name| match name {
        "KR" => Ok(Some(SecretString::from(format!(
            r#"{{"active":2,"keys":{{"2":"{k2}"}}}}"#
        )))),
        "LEG" => Ok(Some(SecretString::from(k1.clone()))),
        _ => Ok(None),
    })
    .unwrap()
    .unwrap();
    assert_eq!(loaded.active_version(), 2);
    assert!(loaded.has_version(1));
}
