// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_comms_credential_cipher::{
    Aad, CURRENT_KEY_VERSION, CipherError, CredentialCipher, EnvelopeCredentialCipher,
};
use console_platform_crypto::{AlgId, LocalKeyringProvider};
use secrecy::ExposeSecret;
use zeroize::Zeroizing;

fn mail_aad<'a>() -> Aad<'a> {
    Aad {
        org_id: "11111111-1111-1111-1111-111111111111",
        account_id: "22222222-2222-2222-2222-222222222222",
        field: "smtp_password",
    }
}

fn rrn_aad<'a>() -> Aad<'a> {
    Aad {
        org_id: "11111111-1111-1111-1111-111111111111",
        account_id: "employee_rrn",
        field: "rrn",
    }
}

#[test]
fn default_writer_stays_v1_while_dual_reader_handles_v1_v2_and_v3() {
    assert_eq!(CURRENT_KEY_VERSION, 1);
    let cipher = EnvelopeCredentialCipher::from_key_bytes(&[0x19u8; 32]).unwrap();

    let v1 = cipher.encrypt(b"smtp-secret", mail_aad()).unwrap();
    assert_eq!(v1.key_version, 1);
    assert!(v1.alg_id.is_none());
    assert!(v1.kek_id.is_none());
    assert!(v1.msg_id.is_none());
    assert!(v1.commitment_tag.is_none());

    let v2 = cipher
        .encrypt_with_suite(2, b"smtp-secret", mail_aad())
        .unwrap();
    assert_eq!(v2.key_version, 2);

    let v3 = cipher
        .encrypt_with_suite(3, b"smtp-secret", mail_aad())
        .unwrap();
    assert_eq!(v3.key_version, 3);
    assert_eq!(
        v3.alg_id.as_deref(),
        Some(AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap.as_str())
    );
    assert_eq!(v3.kek_id.as_deref(), Some("legacy-env-v1"));
    assert_eq!(v3.nonce.len(), 12);
    assert!(v3.dek_nonce.is_empty());
    assert_eq!(v3.dek_wrapped.len(), 40);
    assert_eq!(v3.msg_id.as_deref().map(<[u8]>::len), Some(32));
    assert_eq!(v3.commitment_tag.as_deref().map(<[u8]>::len), Some(32));

    for env in [&v1, &v2, &v3] {
        assert_eq!(cipher.open_bytes(env, mail_aad()).unwrap(), b"smtp-secret");
    }

    // RRN context preserves table = employee_rrn, purpose = rrn_vault
    let rrn_v3 = cipher
        .encrypt_with_suite(3, b"9001011234567", rrn_aad())
        .unwrap();
    assert_eq!(
        cipher.open_bytes(&rrn_v3, rrn_aad()).unwrap(),
        b"9001011234567"
    );
    assert!(matches!(
        cipher.decrypt(&rrn_v3, mail_aad()),
        Err(CipherError::Decrypt)
    ));
}

#[test]
fn v3_negative_tamper_and_rotation_ring_checks() {
    let k1 = BASE64.encode([0x31u8; 32]);
    let k2 = BASE64.encode([0x32u8; 32]);

    let ring1 = LocalKeyringProvider::from_keyring_json(&format!(
        r#"{{"active":"k1","keys":{{"k1":"{k1}"}}}}"#
    ))
    .unwrap();
    let c1 = EnvelopeCredentialCipher::from_local_keyring(ring1);
    let sealed_k1_v1 = c1.encrypt(b"v1-pw", mail_aad()).unwrap();
    let sealed_k1_v3 = c1.encrypt_with_suite(3, b"v3-pw", mail_aad()).unwrap();
    assert_eq!(sealed_k1_v3.kek_id.as_deref(), Some("k1"));

    // Rotate active key to k2 while keeping k1 in ring
    let c2 = EnvelopeCredentialCipher::from_env_values(
        Some(Zeroizing::new(format!(
            r#"{{"active":"k2","keys":{{"k1":"{k1}","k2":"{k2}"}}}}"#
        ))),
        None,
    )
    .unwrap()
    .unwrap();

    assert_eq!(
        c2.decrypt(&sealed_k1_v1, mail_aad())
            .unwrap()
            .expose_secret()
            .as_slice(),
        b"v1-pw"
    );
    assert_eq!(
        c2.decrypt(&sealed_k1_v3, mail_aad())
            .unwrap()
            .expose_secret()
            .as_slice(),
        b"v3-pw"
    );

    // Tamper checks on v3
    let mut bad_commit = sealed_k1_v3.clone();
    bad_commit.commitment_tag.as_mut().unwrap()[0] ^= 1;
    assert!(matches!(
        c2.decrypt(&bad_commit, mail_aad()),
        Err(CipherError::Decrypt)
    ));

    let mut bad_kek = sealed_k1_v3.clone();
    bad_kek.kek_id = Some("k2".to_owned());
    assert!(matches!(
        c2.decrypt(&bad_kek, mail_aad()),
        Err(CipherError::Decrypt)
    ));

    let mut bad_alg = sealed_k1_v3.clone();
    bad_alg.alg_id = Some("reserved-mlkem768-aes256-gcm".to_owned());
    assert!(matches!(
        c2.decrypt(&bad_alg, mail_aad()),
        Err(CipherError::KeyVersion)
    ));

    let mut pq_ver = sealed_k1_v3;
    pq_ver.key_version = 0x0101;
    assert!(matches!(
        c2.decrypt(&pq_ver, mail_aad()),
        Err(CipherError::KeyVersion)
    ));

    // Debug output on cipher never exposes key material
    let dbg = format!("{c2:?}");
    assert!(dbg.contains("k2"));
    assert!(!dbg.contains(&k1));
    assert!(!dbg.contains(&k2));
}
