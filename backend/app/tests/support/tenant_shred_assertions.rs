// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use std::sync::Arc;

use console_app::EnvRrnVault;
use console_app::mail_cipher::TenantEnvMailCipher;
use console_comms_application::{Aad, CredentialCipher, SealedCredential};
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn};
use console_kernel_core::OrgId;
use console_platform_crypto::{TenantDekMode, TenantKeyScope};
use console_platform_db::tenant_keys::{PgTenantKeyStore, TenantKeyError};
use sqlx::PgPool;
use uuid::Uuid;

use super::shred_support::build_env_vault;

pub struct PreShredLegacyEnvelopes {
    pub rrn_v1: SealedRrn,
    pub rrn_v2: SealedRrn,
    pub rrn_direct_v3: SealedRrn,
    pub mail_v1: SealedCredential,
    pub mail_v2: SealedCredential,
    pub mail_direct_v3: SealedCredential,
}

pub fn seal_pre_shred_legacy_envelopes(
    unscoped_vault: &EnvRrnVault,
    mail_base: &EnvelopeCredentialCipher,
    org_uuid: Uuid,
    mail_acc_id: Uuid,
) -> PreShredLegacyEnvelopes {
    let org_s = org_uuid.to_string();
    let acc_s = mail_acc_id.to_string();
    let rrn = Rrn::parse("910101-1234567").unwrap();
    let mut rrn_v1 = unscoped_vault.seal(org_uuid, &rrn).unwrap();
    let mut rrn_v2 = rrn_v1.clone();
    let rrn_aad = Aad {
        org_id: &org_s,
        account_id: "employee_rrn",
        field: "rrn",
    };
    for (target, suite) in [(&mut rrn_v1, 1i16), (&mut rrn_v2, 2i16)] {
        let cred = mail_base
            .encrypt_with_suite(suite, rrn.digits().as_bytes(), rrn_aad)
            .unwrap();
        target.ciphertext = cred.ciphertext;
        target.nonce = cred.nonce;
        target.dek_wrapped = cred.dek_wrapped;
        target.dek_nonce = cred.dek_nonce;
        target.key_version = cred.key_version;
        target.alg_id = cred.alg_id;
        target.kek_id = cred.kek_id;
        target.msg_id = cred.msg_id;
        target.commitment_tag = cred.commitment_tag;
    }
    let rrn_direct_v3 = unscoped_vault.seal(org_uuid, &rrn).unwrap();

    let mail_aad = Aad {
        org_id: &org_s,
        account_id: &acc_s,
        field: "smtp_password",
    };
    PreShredLegacyEnvelopes {
        rrn_v1,
        rrn_v2,
        rrn_direct_v3,
        mail_v1: mail_base
            .encrypt_with_suite(1, b"legacy-v1-pw", mail_aad)
            .unwrap(),
        mail_v2: mail_base
            .encrypt_with_suite(2, b"legacy-v2-pw", mail_aad)
            .unwrap(),
        mail_direct_v3: mail_base
            .encrypt_with_suite(3, b"direct-v3-pw", mail_aad)
            .unwrap(),
    }
}

pub async fn assert_shredded_fail_closed_all_versions(
    owner: &PgPool,
    rt: &PgPool,
    org: OrgId,
    store: &PgTenantKeyStore,
    warm_vault: &EnvRrnVault,
    mail_base: &EnvelopeCredentialCipher,
    tdek_rrn: &SealedRrn,
    tdek_mail: &SealedCredential,
    legacy: &PreShredLegacyEnvelopes,
    mail_acc_id: Uuid,
) {
    let org_uuid = *org.as_uuid();
    // All EV + evidence tables for the erased tenant must be empty.
    for (table, sql) in [
        (
            "docs_evidence_objects",
            "SELECT count(*) FROM docs_evidence_objects WHERE org_id = $1",
        ),
        (
            "docs_evidence_copies",
            "SELECT count(*) FROM docs_evidence_copies WHERE org_id = $1",
        ),
        (
            "docs_evidence_tsa_proofs",
            "SELECT count(*) FROM docs_evidence_tsa_proofs WHERE org_id = $1",
        ),
        (
            "docs_evidence_custody_events",
            "SELECT count(*) FROM docs_evidence_custody_events WHERE org_id = $1",
        ),
        (
            "docs_evidence_exports",
            "SELECT count(*) FROM docs_evidence_exports WHERE org_id = $1",
        ),
        (
            "evidence_media",
            "SELECT count(*) FROM evidence_media WHERE org_id = $1",
        ),
    ] {
        let count: i64 = sqlx::query_scalar(sql) // rls-arming: ok owner verifies wiped tables
            .bind(org_uuid)
            .fetch_one(owner)
            .await
            .unwrap();
        assert_eq!(count, 0, "expected {table} wiped for {org_uuid}");
    }

    // Warm TenantDekCache eviction + refusal of new DEK provisioning / rotation.
    assert!(
        store
            .active_target_kek_for_org(
                rt,
                org,
                TenantKeyScope::Rrn,
                mail_base.kms_provider().as_ref()
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        store
            .rotate_tenant_dek(
                rt,
                org,
                TenantKeyScope::Rrn,
                Arc::clone(mail_base.kms_provider()),
                None
            )
            .await,
        Err(TenantKeyError::Shredded)
    ));

    let warm_scoped_vault = warm_vault.scoped_for_org(org_uuid).await.unwrap().unwrap();
    let sample_rrn = Rrn::parse("900101-1234567").unwrap();
    assert!(warm_scoped_vault.seal(org_uuid, &sample_rrn).is_err());
    for sealed in [
        tdek_rrn,
        &legacy.rrn_direct_v3,
        &legacy.rrn_v2,
        &legacy.rrn_v1,
    ] {
        assert!(warm_scoped_vault.open(org_uuid, sealed).is_err());
    }

    let shredded_mail_kms = store
        .load_scope_for_org(
            rt,
            org,
            TenantKeyScope::Mail,
            Arc::clone(mail_base.kms_provider()),
        )
        .await
        .unwrap();
    let shredded_mail = mail_base.with_tenant_kms(Arc::new(shredded_mail_kms));
    let aad = Aad {
        org_id: &org.to_string(),
        account_id: &mail_acc_id.to_string(),
        field: "smtp_password",
    };
    assert!(shredded_mail.encrypt(b"post-shred", aad).is_err());
    for sealed in [
        tdek_mail,
        &legacy.mail_direct_v3,
        &legacy.mail_v2,
        &legacy.mail_v1,
    ] {
        assert!(shredded_mail.decrypt(sealed, aad).is_err());
        assert!(shredded_mail.open_bytes(sealed, aad).is_err());
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn assert_cold_pitr_fails_closed(
    rt: &PgPool,
    org: OrgId,
    ring: &str,
    h_b64: &str,
    mail_base: &Arc<EnvelopeCredentialCipher>,
    sealed_a: &SealedRrn,
    staged_a: &SealedRrn,
    smtp_password: &SealedCredential,
    imap_password: &SealedCredential,
    acc_a: Uuid,
) {
    let org_uuid = *org.as_uuid();
    let cold_store = Arc::new(PgTenantKeyStore::new(TenantDekMode::Active));
    let cold_vault = build_env_vault(rt.clone(), ring, h_b64, cold_store);
    let cold_mail = TenantEnvMailCipher::new(Arc::clone(mail_base), rt.clone());
    for sealed in [sealed_a, staged_a] {
        assert!(
            cold_vault
                .scoped_for_org(org_uuid)
                .await
                .unwrap()
                .unwrap()
                .open(org_uuid, sealed)
                .is_err()
        );
    }
    let cold_mail_scoped = cold_mail.scoped_for_org(org_uuid).await.unwrap().unwrap();
    let smtp_aad = Aad {
        org_id: &org.to_string(),
        account_id: &acc_a.to_string(),
        field: "smtp_password",
    };
    let imap_aad = Aad {
        org_id: &org.to_string(),
        account_id: &acc_a.to_string(),
        field: "imap_password",
    };
    assert!(cold_mail_scoped.decrypt(smtp_password, smtp_aad).is_err());
    assert!(cold_mail_scoped.decrypt(imap_password, imap_aad).is_err());
}
