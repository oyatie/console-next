// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_platform_crypto::{
    CryptoError, DEFAULT_LEGACY_KEK_ID, EnvelopeContext, KekId, KmsProvider, LocalKeyringProvider,
    open_v3, seal_v3,
};
use secrecy::{ExposeSecret, SecretString};
use zeroize::Zeroizing;

fn ctx() -> EnvelopeContext<'static> {
    EnvelopeContext {
        tenant_id: "11111111-1111-1111-1111-111111111111",
        table: "employee_rrn",
        record: "employee_rrn",
        field: "rrn",
        purpose: "rrn_vault",
    }
}

#[test]
fn multi_key_rotation_ring_wraps_with_active_and_unwraps_retired_keys() {
    let k1_b64 = BASE64.encode([0x11u8; 32]);
    let k2_b64 = BASE64.encode([0x22u8; 32]);

    let ring_v1 = LocalKeyringProvider::from_keyring_json(&format!(
        r#"{{"active":"kek-2026-10","keys":{{"kek-2026-10":"{k1_b64}"}}}}"#
    ))
    .unwrap();
    let sealed_under_v1 = seal_v3(&ring_v1, ctx(), b"9001011234567").unwrap();
    assert_eq!(sealed_under_v1.header.kek_id.as_str(), "kek-2026-10");

    // Rotate active key to kek-2026-11 while retaining kek-2026-10
    let ring_v2 = LocalKeyringProvider::from_keyring_json(&format!(
        r#"{{"active":"kek-2026-11","keys":{{"kek-2026-10":"{k1_b64}","kek-2026-11":"{k2_b64}"}}}}"#
    ))
    .unwrap();
    assert_eq!(ring_v2.active_kek_id().as_str(), "kek-2026-11");

    // Old ciphertext unwraps via retained key
    let opened_old = open_v3(&ring_v2, ctx(), &sealed_under_v1).unwrap();
    assert_eq!(opened_old.expose_secret().as_slice(), b"9001011234567");

    // New ciphertext seals under new active key
    let sealed_under_v2 = seal_v3(&ring_v2, ctx(), b"9001011234567").unwrap();
    assert_eq!(sealed_under_v2.header.kek_id.as_str(), "kek-2026-11");
    assert_eq!(
        open_v3(&ring_v2, ctx(), &sealed_under_v2)
            .unwrap()
            .expose_secret()
            .as_slice(),
        b"9001011234567"
    );

    // Old single-key ring cannot open new key ciphertext
    assert_eq!(
        open_v3(&ring_v1, ctx(), &sealed_under_v2).err(),
        Some(CryptoError::Decrypt)
    );

    // Debug output never leaks base64 or raw key material
    let dbg = format!("{ring_v2:?}");
    assert!(dbg.contains("kek-2026-11"));
    assert!(dbg.contains("REDACTED"));
    assert!(!dbg.contains(&k1_b64));
    assert!(!dbg.contains(&k2_b64));
}

#[test]
fn env_values_merge_legacy_master_and_reject_conflicts() {
    let legacy_b64 = BASE64.encode([0x55u8; 32]);
    let k2_b64 = BASE64.encode([0x66u8; 32]);
    let other_b64 = BASE64.encode([0x77u8; 32]);

    // Legacy-only fallback assigns DEFAULT_LEGACY_KEK_ID
    let legacy_only =
        LocalKeyringProvider::from_env_values(None, Some(Zeroizing::new(legacy_b64.clone())))
            .unwrap()
            .unwrap();
    assert_eq!(legacy_only.active_kek_id().as_str(), DEFAULT_LEGACY_KEK_ID);

    // Combining keyring + legacy master merges legacy key cleanly
    let merged = LocalKeyringProvider::from_env_values(
        Some(Zeroizing::new(format!(
            r#"{{"active":"kek-2","keys":{{"kek-2":"{k2_b64}"}}}}"#
        ))),
        Some(Zeroizing::new(legacy_b64.clone())),
    )
    .unwrap()
    .unwrap();
    assert_eq!(merged.active_kek_id().as_str(), "kek-2");
    assert!(merged.get_key(&KekId::legacy_default()).is_some());

    // Conflicting legacy-env-v1 key material fails closed
    let conflict = LocalKeyringProvider::from_env_values(
        Some(Zeroizing::new(format!(
            r#"{{"active":"legacy-env-v1","keys":{{"legacy-env-v1":"{other_b64}"}}}}"#
        ))),
        Some(Zeroizing::new(legacy_b64)),
    );
    assert_eq!(conflict.unwrap_err(), CryptoError::InvalidKeyMaterial);
}

#[test]
fn invalid_keyring_inputs_and_env_vars_fail_closed() {
    let valid_b64 = BASE64.encode([0x11u8; 32]);
    for bad_json in [
        "{}",
        r#"{"active":"missing","keys":{}}"#,
        &format!(r#"{{"active":"k2","keys":{{"k1":"{valid_b64}"}}}}"#),
        &format!(r#"{{"active":"bad id!","keys":{{"bad id!":"{valid_b64}"}}}}"#),
        r#"{"active":"k1","keys":{"k1":"not-base64!"}}"#,
        &format!(
            r#"{{"active":"k1","keys":{{"k1":"{}"}}}}"#,
            BASE64.encode([1u8; 16])
        ),
        &format!(r#"{{"active":"k1","keys":{{"k1":"{valid_b64}"}},"extra":1}}"#),
    ] {
        assert_eq!(
            LocalKeyringProvider::from_keyring_json(bad_json).unwrap_err(),
            CryptoError::InvalidKeyMaterial
        );
    }

    let loaded = LocalKeyringProvider::from_env_vars(
        "CONSOLE_TEST_KEYRING",
        "CONSOLE_TEST_MASTER_KEY",
        |name| match name {
            "CONSOLE_TEST_KEYRING" => Ok(Some(SecretString::from(format!(
                r#"{{"active":"k1","keys":{{"k1":"{valid_b64}"}}}}"#
            )))),
            "CONSOLE_TEST_MASTER_KEY" => Ok(None),
            _ => Ok(None),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(loaded.active_kek_id().as_str(), "k1");
}
