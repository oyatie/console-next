// SPDX-License-Identifier: LicenseRef-Proprietary
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use std::sync::atomic::{AtomicUsize, Ordering};
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Vault(pub(super) AtomicUsize);

impl RrnVault for Vault {
    fn seal(&self, org: Uuid, r: &Rrn) -> Result<SealedRrn, VaultError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(SealedRrn {
            hmac: self.blind_index_v1(r),
            hmac_key_version: 1,
            hmac_v2: Some(self.blind_index(org, r)),
            blind_index_version: Some(2),
            ciphertext: vec![0; 16],
            nonce: vec![0; 24],
            dek_wrapped: vec![0; 16],
            dek_nonce: vec![0; 24],
            key_version: 1,
            masked: r.masked(),
            alg_id: None,
            kek_id: None,
            msg_id: None,
            commitment_tag: None,
        })
    }

    fn blind_index(&self, org: Uuid, r: &Rrn) -> Vec<u8> {
        org.as_bytes()
            .iter()
            .copied()
            .chain(r.digits().bytes())
            .cycle()
            .take(32)
            .collect()
    }

    fn blind_index_v1(&self, r: &Rrn) -> Vec<u8> {
        r.digits().bytes().cycle().take(32).collect()
    }

    fn open(&self, _: Uuid, _: &SealedRrn) -> Result<Rrn, VaultError> {
        Err(VaultError)
    }
}
