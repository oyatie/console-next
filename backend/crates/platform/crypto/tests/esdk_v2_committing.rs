// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use console_platform_crypto::{
    AlgId, AsyncKmsProvider, AwsKmsConfig, AwsKmsProvider, CryptoError, EnvelopeContext,
    EnvelopeWire, HsmKmsConfig, HsmKmsProvider, KekId, LocalKeyringProvider, OciVaultKmsConfig,
    OciVaultKmsProvider, open_v3, seal_v3,
};
use secrecy::{ExposeSecret, SecretBox, SecretString};

fn ctx() -> EnvelopeContext<'static> {
    EnvelopeContext {
        tenant_id: "11111111-1111-1111-1111-111111111111",
        table: "email_accounts",
        record: "22222222-2222-2222-2222-222222222222",
        field: "smtp_password",
        purpose: "credential",
    }
}

fn ring() -> LocalKeyringProvider {
    LocalKeyringProvider::from_single_key(
        KekId::new("mail-2026-11").unwrap(),
        SecretBox::new(Box::new([0x42u8; 32])),
    )
}

#[test]
fn seal_open_v3_and_wire_codec_round_trip() {
    let kms = ring();
    let sealed = seal_v3(&kms, ctx(), b"top-secret-smtp-password").unwrap();
    assert_eq!(
        sealed.header.alg_id,
        AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap
    );
    assert_eq!(sealed.header.kek_id.as_str(), "mail-2026-11");
    assert_eq!(sealed.header.wrapped_dek.len(), 40);

    let wire = EnvelopeWire::encode(&sealed).unwrap();
    assert!(wire.starts_with(b"CEV2"));
    let decoded = EnvelopeWire::decode(&wire).unwrap();
    assert_eq!(decoded, sealed);

    let plain = open_v3(&kms, ctx(), &decoded).unwrap();
    assert_eq!(
        plain.expose_secret().as_slice(),
        b"top-secret-smtp-password"
    );
    let dbg = format!("{plain:?}");
    assert!(dbg.contains("REDACTED"));
    assert!(!dbg.contains("top-secret-smtp-password"));
}

#[test]
fn commitment_tag_and_header_tamper_fail_closed() {
    let kms = ring();
    let original = seal_v3(&kms, ctx(), b"secret").unwrap();

    let mut bad_commit = original.clone();
    bad_commit.header.commitment_tag[0] ^= 0x01;
    assert_eq!(
        open_v3(&kms, ctx(), &bad_commit).err(),
        Some(CryptoError::Decrypt)
    );

    let mut bad_msg_id = original.clone();
    bad_msg_id.header.msg_id[31] ^= 0x80;
    assert_eq!(
        open_v3(&kms, ctx(), &bad_msg_id).err(),
        Some(CryptoError::Decrypt)
    );

    let other = seal_v3(&kms, ctx(), b"other").unwrap();
    let mut swapped_dek = original.clone();
    swapped_dek.header.wrapped_dek = other.header.wrapped_dek;
    assert_eq!(
        open_v3(&kms, ctx(), &swapped_dek).err(),
        Some(CryptoError::Decrypt)
    );

    // Swapping commitment tag from another envelope must also fail closed
    let mut swapped_commit = original.clone();
    swapped_commit.header.commitment_tag = other.header.commitment_tag;
    assert_eq!(
        open_v3(&kms, ctx(), &swapped_commit).err(),
        Some(CryptoError::Decrypt)
    );

    let mut bad_nonce = original.clone();
    bad_nonce.header.nonce[0] ^= 0x01;
    assert_eq!(
        open_v3(&kms, ctx(), &bad_nonce).err(),
        Some(CryptoError::Decrypt)
    );

    let mut bad_ct = original.clone();
    let last = bad_ct.ciphertext.len() - 1;
    bad_ct.ciphertext[last] ^= 0x01;
    assert_eq!(
        open_v3(&kms, ctx(), &bad_ct).err(),
        Some(CryptoError::Decrypt)
    );

    let mut wrong_kek = original.clone();
    wrong_kek.header.kek_id = KekId::new("unknown-kek").unwrap();
    assert_eq!(
        open_v3(&kms, ctx(), &wrong_kek).err(),
        Some(CryptoError::Decrypt)
    );
}

#[test]
fn cross_context_aad_transplants_are_rejected() {
    let kms = ring();
    let sealed = seal_v3(&kms, ctx(), b"rrn-or-password").unwrap();

    for mut bad_ctx in [
        EnvelopeContext {
            tenant_id: "99999999-9999-9999-9999-999999999999",
            ..ctx()
        },
        EnvelopeContext {
            table: "employee_rrn",
            ..ctx()
        },
        EnvelopeContext {
            record: "33333333-3333-3333-3333-333333333333",
            ..ctx()
        },
        EnvelopeContext {
            field: "imap_password",
            ..ctx()
        },
        EnvelopeContext {
            purpose: "rrn_vault",
            ..ctx()
        },
    ] {
        assert_eq!(
            open_v3(&kms, bad_ctx, &sealed).err(),
            Some(CryptoError::Decrypt)
        );
        bad_ctx.purpose = "other";
        assert_eq!(
            open_v3(&kms, bad_ctx, &sealed).err(),
            Some(CryptoError::Decrypt)
        );
    }
}

#[test]
fn unknown_and_pq_reserved_algorithms_fail_closed() {
    let kms = ring();
    let mut pq = seal_v3(&kms, ctx(), b"pq-test").unwrap();
    pq.header.alg_id = AlgId::ReservedMlKem768Aes256Gcm;
    assert_eq!(
        open_v3(&kms, ctx(), &pq).err(),
        Some(CryptoError::UnsupportedAlgorithm)
    );
    assert!(AlgId::ReservedMlKem768Aes256Gcm.is_pq_reserved());
    assert!(!AlgId::ReservedMlKem768Aes256Gcm.is_supported_for_seal());

    let mut wire = EnvelopeWire::encode(&pq).unwrap();
    wire[5] = 0x77;
    wire[6] = 0x77;
    assert_eq!(
        EnvelopeWire::decode(&wire),
        Err(CryptoError::UnsupportedAlgorithm)
    );
}

#[tokio::test]
async fn remote_kms_stubs_enforce_https_redact_debug_and_fail_closed() {
    assert_eq!(
        OciVaultKmsProvider::new(OciVaultKmsConfig {
            endpoint_url: "http://insecure.example.com".to_owned(),
            key_ocid: KekId::new("ocid1.key.oc1.ap-seoul-1.abc").unwrap(),
            compartment_ocid: "ocid1.compartment.oc1..xyz".to_owned(),
            auth_token: SecretString::from("super-secret-oci-token"),
        })
        .unwrap_err(),
        CryptoError::InvalidInput
    );

    let oci = OciVaultKmsProvider::new(OciVaultKmsConfig {
        endpoint_url: "https://kms.ap-seoul-1.oraclecloud.com".to_owned(),
        key_ocid: KekId::new("ocid1.key.oc1.ap-seoul-1.abc").unwrap(),
        compartment_ocid: "ocid1.compartment.oc1..xyz".to_owned(),
        auth_token: SecretString::from("super-secret-oci-token"),
    })
    .unwrap();
    assert!(!format!("{oci:?}").contains("super-secret-oci-token"));
    let dek = SecretBox::new(Box::new([1u8; 32]));
    assert_eq!(
        oci.wrap_dek("credential", &dek).await,
        Err(CryptoError::ProviderUnavailable)
    );
    assert_eq!(
        oci.unwrap_dek(oci.active_kek_id(), "credential", &[0; 40])
            .await
            .err(),
        Some(CryptoError::ProviderUnavailable)
    );

    let aws = AwsKmsProvider::new(AwsKmsConfig {
        region: "ap-northeast-2".to_owned(),
        key_id: KekId::new("arn:aws:kms:ap-northeast-2:123456789012:key/abc").unwrap(),
        endpoint_url: "https://kms.ap-northeast-2.amazonaws.com".to_owned(),
        access_token: SecretString::from("super-secret-aws-token"),
    })
    .unwrap();
    assert!(!format!("{aws:?}").contains("super-secret-aws-token"));
    assert_eq!(
        aws.wrap_dek("credential", &dek).await,
        Err(CryptoError::ProviderUnavailable)
    );

    let hsm = HsmKmsProvider::new(HsmKmsConfig {
        endpoint_url: "https://hsm.internal.example".to_owned(),
        key_id: KekId::new("hsm-slot-0-kek-1").unwrap(),
        client_id: "console-prod".to_owned(),
        client_secret: SecretString::from("super-secret-hsm-pin"),
    })
    .unwrap();
    assert!(!format!("{hsm:?}").contains("super-secret-hsm-pin"));
    assert_eq!(
        hsm.unwrap_dek(hsm.active_kek_id(), "credential", &[0; 40])
            .await
            .err(),
        Some(CryptoError::ProviderUnavailable)
    );
}
