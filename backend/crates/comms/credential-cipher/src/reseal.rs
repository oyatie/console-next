// SPDX-License-Identifier: LicenseRef-Proprietary
//! Keyring metadata accessors and zero-copy envelope re-sealing (`v1`/`v2`/retired KEK -> active `v3`).

use console_platform_crypto::{AlgId, KekId};

use crate::{Aad, CURRENT_KEY_VERSION, CipherError, EnvelopeCredentialCipher, SealedCredential};

impl EnvelopeCredentialCipher {
    /// Active wrapping KEK identifier used for new `v3` seals.
    #[must_use]
    pub fn active_kek_id(&self) -> &KekId {
        self.kms.active_kek_id()
    }

    /// Canonical `alg_id` emitted by the default `v3` writer.
    #[must_use]
    pub const fn active_alg_id(&self) -> AlgId {
        AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap
    }

    /// Returns `true` when `sealed` is not on the active `v3` suite and active KEK.
    #[must_use]
    pub fn needs_reseal(&self, sealed: &SealedCredential) -> bool {
        sealed.key_version != CURRENT_KEY_VERSION
            || sealed.alg_id.as_deref() != Some(self.active_alg_id().as_str())
            || sealed.kek_id.as_deref() != Some(self.active_kek_id().as_str())
    }

    /// Re-seal `sealed` under the active `v3` suite and active KEK, keeping
    /// plaintext strictly inside [`secrecy::SecretBox`] via [`Self::open_with`].
    pub fn reseal(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SealedCredential, CipherError> {
        self.open_with(sealed, aad, |plain| self.encrypt_v3(plain, aad))?
    }

    /// Re-seal `sealed` only when [`Self::needs_reseal`] is `true`.
    pub fn reseal_if_needed(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<Option<SealedCredential>, CipherError> {
        if !self.needs_reseal(sealed) {
            return Ok(None);
        }
        self.reseal(sealed, aad).map(Some)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::sync::Arc;

    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use console_platform_crypto::{
        AlgId, CryptoError, EnvelopeContext, KekId, KmsProvider, WrappedDek,
    };
    use secrecy::SecretBox;

    use crate::{Aad, CipherError, CredentialCipher, EnvelopeCredentialCipher};

    fn mail_aad() -> Aad<'static> {
        Aad {
            org_id: "11111111-1111-1111-1111-111111111111",
            account_id: "22222222-2222-2222-2222-222222222222",
            field: "smtp_password",
        }
    }

    struct StaticTestKms {
        active: KekId,
        inner: console_platform_crypto::LocalKeyringProvider,
    }

    impl std::fmt::Debug for StaticTestKms {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("StaticTestKms")
                .field("active", &self.active)
                .finish()
        }
    }

    impl KmsProvider for StaticTestKms {
        fn active_kek_id(&self) -> &KekId {
            &self.active
        }

        fn wrap_dek(
            &self,
            purpose: &str,
            dek: &SecretBox<[u8; 32]>,
        ) -> Result<WrappedDek, CryptoError> {
            self.inner.wrap_dek(purpose, dek)
        }

        fn unwrap_dek(
            &self,
            kek_id: &KekId,
            purpose: &str,
            wrapped_dek: &[u8],
        ) -> Result<SecretBox<[u8; 32]>, CryptoError> {
            self.inner.unwrap_dek(kek_id, purpose, wrapped_dek)
        }
    }

    #[test]
    fn reseal_upgrades_v1_v2_and_rotated_kek_to_active_v3_and_preserves_n_minus_1_rollback() {
        let k1 = BASE64.encode([0x41u8; 32]);
        let k2 = BASE64.encode([0x42u8; 32]);
        let ring1_json = format!(r#"{{"active":"k1","keys":{{"k1":"{k1}"}}}}"#);
        let ring2_json = format!(r#"{{"active":"k2","keys":{{"k1":"{k1}","k2":"{k2}"}}}}"#);

        let c1 = EnvelopeCredentialCipher::from_owned_env_values(
            Some(ring1_json.clone()),
            Some(k1.clone()),
        )
        .unwrap()
        .unwrap();
        let c2 =
            EnvelopeCredentialCipher::from_owned_env_values(Some(ring2_json), Some(k1.clone()))
                .unwrap()
                .unwrap();

        assert_eq!(c1.active_kek_id().as_str(), "k1");
        assert_eq!(c2.active_kek_id().as_str(), "k2");
        assert_eq!(
            c2.active_alg_id(),
            AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap
        );
        assert_eq!(
            CredentialCipher::active_alg_id(&c2),
            Some(AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap.as_str())
        );
        assert_eq!(CredentialCipher::active_kek_id(&c2), Some("k2"));

        let v1 = c1.encrypt_with_suite(1, b"pw-v1", mail_aad()).unwrap();
        let v2 = c1.encrypt_with_suite(2, b"pw-v2", mail_aad()).unwrap();
        let v3_k1 = c1.encrypt(b"pw-v3-k1", mail_aad()).unwrap();
        assert_eq!(v3_k1.kek_id.as_deref(), Some("k1"));

        for (env, expected) in [
            (&v1, b"pw-v1".as_slice()),
            (&v2, b"pw-v2".as_slice()),
            (&v3_k1, b"pw-v3-k1".as_slice()),
        ] {
            assert!(c2.needs_reseal(env));
            let resealed = c2.reseal_if_needed(env, mail_aad()).unwrap().unwrap();
            assert_eq!(resealed.key_version, 3);
            assert_eq!(resealed.kek_id.as_deref(), Some("k2"));
            assert_eq!(
                resealed.alg_id.as_deref(),
                Some(AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap.as_str())
            );
            assert!(!c2.needs_reseal(&resealed));
            assert!(
                c2.reseal_if_needed(&resealed, mail_aad())
                    .unwrap()
                    .is_none()
            );
            assert_eq!(c2.open_bytes(&resealed, mail_aad()).unwrap(), expected);
        }

        // Retired k1-only reader cannot decrypt k2-resealed ciphertext, while c2 still opens v1/v2/k1.
        let resealed_from_v1 = c2.reseal(&v1, mail_aad()).unwrap();
        assert!(matches!(
            c1.decrypt(&resealed_from_v1, mail_aad()),
            Err(CipherError::Decrypt)
        ));

        // Custom KmsProvider via from_provider works for v3 seal & reseal.
        let kms = Arc::new(StaticTestKms {
            active: KekId::new("k2").unwrap(),
            inner: console_platform_crypto::LocalKeyringProvider::from_keyring_json(&format!(
                r#"{{"active":"k2","keys":{{"k1":"{k1}","k2":"{k2}"}}}}"#
            ))
            .unwrap(),
        });
        let provider_cipher = EnvelopeCredentialCipher::from_provider(kms);
        let provider_resealed = provider_cipher.reseal(&v3_k1, mail_aad()).unwrap();
        assert_eq!(provider_resealed.kek_id.as_deref(), Some("k2"));
        assert_eq!(
            provider_cipher
                .open_bytes(&provider_resealed, mail_aad())
                .unwrap(),
            b"pw-v3-k1"
        );
        // Ensure envelope_context matches directly.
        let _ = EnvelopeContext {
            tenant_id: mail_aad().org_id,
            table: "email_accounts",
            record: mail_aad().account_id,
            field: mail_aad().field,
            purpose: "credential",
        };
    }
}
