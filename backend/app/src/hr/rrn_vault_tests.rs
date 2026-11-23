// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use aws_lc_rs::hmac;
use base64::Engine as _;

impl EnvRrnVault {
    pub fn from_keys(master: &str, hmac: &str) -> Result<Self, String> {
        let cipher = EnvelopeCredentialCipher::from_base64_key(master)
            .map_err(|_| format!("{MASTER_KEY_ENV} is not a base64 32-byte key"))?;
        let hmac_ring = BlindIndexKeyring::from_single_legacy_base64(hmac)
            .map_err(|_| format!("{HMAC_KEY_ENV} is not a base64 32-byte key"))?;
        Ok(Self {
            cipher,
            hmac_ring: std::sync::Arc::new(hmac_ring),
            tenant_keys: None,
        })
    }

    pub fn from_keyrings(
        master_keyring: Option<&str>,
        legacy_master: Option<&str>,
        hmac_keyring: Option<&str>,
        legacy_hmac: Option<&str>,
    ) -> Result<Self, String> {
        let cipher = EnvelopeCredentialCipher::from_owned_env_values(
            master_keyring.map(str::to_owned),
            legacy_master.map(str::to_owned),
        )
        .map_err(|_| format!("{MASTER_KEY_ENV}/{KEYRING_ENV} is invalid"))?
        .ok_or_else(|| format!("{MASTER_KEY_ENV}/{KEYRING_ENV} unset"))?;
        let hmac_ring = BlindIndexKeyring::from_owned_env_values(
            hmac_keyring.map(str::to_owned),
            legacy_hmac.map(str::to_owned),
        )
        .map_err(|_| format!("{HMAC_KEY_ENV}/{HMAC_KEYRING_ENV} is invalid"))?
        .ok_or_else(|| format!("{HMAC_KEY_ENV}/{HMAC_KEYRING_ENV} unset"))?;
        Ok(Self {
            cipher,
            hmac_ring: std::sync::Arc::new(hmac_ring),
            tenant_keys: None,
        })
    }

    #[must_use]
    pub fn from_provider(
        kms: std::sync::Arc<dyn console_platform_crypto::KmsProvider>,
        hmac_ring: BlindIndexKeyring,
    ) -> Self {
        Self {
            cipher: EnvelopeCredentialCipher::from_provider(kms),
            hmac_ring: std::sync::Arc::new(hmac_ring),
            tenant_keys: None,
        }
    }
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), message)
        .as_ref()
        .to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn hmac_preserves_existing_32_byte_key_indexes() {
    for (key, message, expected) in [
        (
            [0u8; 32],
            b"".as_slice(),
            "b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad",
        ),
        (
            [7u8; 32],
            b"synthetic identity",
            "d4c969fedc30197c0f4e3cf0d03f34b132b08585e4205488cf9e3999a699dfbf",
        ),
    ] {
        assert_eq!(hex(&hmac_sha256(&key, message)), expected);
    }
}

#[test]
fn hmac_matches_rfc_4231_case_1() {
    assert_eq!(
        hex(&hmac_sha256(&[0x0b; 20], b"Hi There")),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
}

#[test]
fn historical_v1_rrn_binding_remains_readable() {
    let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let vault = EnvRrnVault::from_keys(&key, &key).unwrap();
    let org = Uuid::new_v4();
    let rrn = Rrn::parse("900101-1234567").unwrap();
    let credential = vault
        .cipher
        .encrypt_with_suite(
            1,
            rrn.digits().as_bytes(),
            Aad {
                org_id: &org.to_string(),
                account_id: "employee_rrn",
                field: "rrn",
            },
        )
        .unwrap();
    let sealed = SealedRrn {
        hmac: vault.blind_index_v1(&rrn),
        hmac_key_version: 1,
        hmac_v2: None,
        blind_index_version: None,
        ciphertext: credential.ciphertext,
        nonce: credential.nonce,
        dek_wrapped: credential.dek_wrapped,
        dek_nonce: credential.dek_nonce,
        key_version: credential.key_version,
        masked: rrn.masked(),
        alg_id: credential.alg_id,
        kek_id: credential.kek_id,
        msg_id: credential.msg_id,
        commitment_tag: credential.commitment_tag,
    };
    assert_eq!(sealed.key_version, 1);
    assert_eq!(vault.open(org, &sealed).unwrap(), rrn);
    assert_eq!(vault.open(Uuid::new_v4(), &sealed), Err(VaultError));
}

#[test]
fn a_sealed_number_opens_only_for_its_tenant_and_matches_by_hash() {
    let raw: [u8; 32] = core::array::from_fn(|i| i as u8);
    let key = base64::engine::general_purpose::STANDARD.encode(raw);
    let vault = EnvRrnVault::from_keys(&key, &key).unwrap();
    let (org, other) = (Uuid::new_v4(), Uuid::new_v4());
    let rrn = Rrn::parse("900101-1234567").unwrap();
    let sealed = vault.seal(org, &rrn).unwrap();
    assert_eq!(sealed.masked, "900101-1******");
    assert_eq!(sealed.hmac_key_version, 1);
    assert_eq!(
        hex(&sealed.hmac),
        "50ac32b2efe7b34cedaa4452d5048195e05b40e40d5129644fb1dd8ab12bc2bc"
    );
    assert_eq!(sealed.blind_index_version, Some(2));
    let normalized = Rrn::parse("9001011234567").unwrap();
    assert_eq!(sealed.hmac_v2, Some(vault.blind_index(org, &normalized)));
    assert_ne!(vault.blind_index(org, &rrn), vault.blind_index(other, &rrn));
    assert_ne!(sealed.hmac_v2.as_deref(), Some(sealed.hmac.as_slice()));
    assert!(!sealed.ciphertext.windows(7).any(|w| w == b"1234567"));
    assert_eq!(vault.open(org, &sealed).unwrap(), rrn);
    assert_eq!(vault.open(other, &sealed), Err(VaultError));
    assert!(EnvRrnVault::from_keys("bad", &key).is_err());

    let provider = std::sync::Arc::new(
        console_platform_crypto::LocalKeyringProvider::from_single_base64(
            console_platform_crypto::KekId::legacy_default(),
            &key,
        )
        .unwrap(),
    );
    let hmac_ring = BlindIndexKeyring::from_single_legacy_base64(&key).unwrap();
    let pv = EnvRrnVault::from_provider(provider, hmac_ring);
    let pv_sealed = pv.seal(org, &rrn).unwrap();
    assert_eq!(pv.open(org, &pv_sealed).unwrap(), rrn);
    assert_eq!(pv.active_kek_id(), Some("legacy-env-v1"));
    assert_eq!(
        pv.active_alg_id(),
        Some("aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp")
    );
    let pv_resealed = pv.reseal(org, &pv_sealed).unwrap();
    assert_eq!(pv.open(org, &pv_resealed).unwrap(), rrn);
}
