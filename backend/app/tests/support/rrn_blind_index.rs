// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_comms_credential_cipher::{
    Aad, CredentialCipher, EnvelopeCredentialCipher, SealedCredential,
};
use console_hr_adapter_postgres::HrService;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use console_platform_crypto::{BlindIndexContext, BlindIndexKeyring, LEGACY_HMAC_KEY_VERSION};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::sync::Arc;
use uuid::Uuid;

pub struct TestEnvVault {
    pub cipher: EnvelopeCredentialCipher,
    pub hmac_ring: BlindIndexKeyring,
}

impl TestEnvVault {
    pub fn new(master_byte: u8, hmac_byte: u8) -> Arc<Self> {
        let m_b64 = BASE64.encode([master_byte; 32]);
        let h_b64 = BASE64.encode([hmac_byte; 32]);
        let cipher = EnvelopeCredentialCipher::from_base64_key(&m_b64).unwrap();
        let hmac_ring = BlindIndexKeyring::from_single_legacy_base64(&h_b64).unwrap();
        Arc::new(Self { cipher, hmac_ring })
    }
}

fn aad(org: &str) -> Aad<'_> {
    Aad {
        org_id: org,
        account_id: "employee_rrn",
        field: "rrn",
    }
}

fn ctx(org_id: Uuid) -> BlindIndexContext<'static> {
    BlindIndexContext {
        org_id,
        table: "employee_rrn",
        field: "rrn",
    }
}

impl RrnVault for TestEnvVault {
    fn seal(&self, org: Uuid, rrn: &Rrn) -> Result<SealedRrn, VaultError> {
        let org_str = org.to_string();
        let sealed = self
            .cipher
            .encrypt(rrn.digits().as_bytes(), aad(&org_str))
            .map_err(|_| VaultError)?;
        let (ver, v2) = self
            .hmac_ring
            .compute_active(ctx(org), rrn.digits().as_bytes())
            .map_err(|_| VaultError)?;
        let v1 = self
            .hmac_ring
            .compute_for_version(LEGACY_HMAC_KEY_VERSION, ctx(org), rrn.digits().as_bytes())
            .map_err(|_| VaultError)?;
        Ok(SealedRrn {
            hmac: v1.to_vec(),
            hmac_key_version: 1,
            hmac_v2: Some(v2.to_vec()),
            blind_index_version: Some(ver),
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            dek_wrapped: sealed.dek_wrapped,
            dek_nonce: sealed.dek_nonce,
            key_version: sealed.key_version,
            masked: rrn.masked(),
            alg_id: sealed.alg_id,
            kek_id: sealed.kek_id,
            msg_id: sealed.msg_id,
            commitment_tag: sealed.commitment_tag,
        })
    }

    fn blind_index(&self, org: Uuid, rrn: &Rrn) -> Vec<u8> {
        self.hmac_ring
            .compute_active(ctx(org), rrn.digits().as_bytes())
            .map(|(_, d)| d.to_vec())
            .unwrap_or_default()
    }

    fn blind_index_v1(&self, rrn: &Rrn) -> Vec<u8> {
        self.hmac_ring
            .compute_for_version(
                LEGACY_HMAC_KEY_VERSION,
                ctx(Uuid::nil()),
                rrn.digits().as_bytes(),
            )
            .map(|d| d.to_vec())
            .unwrap_or_default()
    }

    fn active_blind_index_version(&self) -> i16 {
        self.hmac_ring.active_version()
    }

    fn blind_index_v2_candidates(&self, org: Uuid, rrn: &Rrn) -> Vec<Vec<u8>> {
        self.hmac_ring
            .compute_v2_candidates(ctx(org), rrn.digits().as_bytes())
            .map(|v| v.into_iter().map(|(_, d)| d.to_vec()).collect())
            .unwrap_or_default()
    }

    fn open(&self, org: Uuid, sealed: &SealedRrn) -> Result<Rrn, VaultError> {
        let org_str = org.to_string();
        let cred = SealedCredential {
            ciphertext: sealed.ciphertext.clone(),
            nonce: sealed.nonce.clone(),
            dek_wrapped: sealed.dek_wrapped.clone(),
            dek_nonce: sealed.dek_nonce.clone(),
            key_version: sealed.key_version,
            alg_id: sealed.alg_id.clone(),
            kek_id: sealed.kek_id.clone(),
            msg_id: sealed.msg_id.clone(),
            commitment_tag: sealed.commitment_tag.clone(),
        };
        self.cipher
            .open_with(&cred, aad(&org_str), |plain| {
                let text = std::str::from_utf8(plain).map_err(|_| VaultError)?;
                Rrn::parse(text).map_err(|_| VaultError)
            })
            .map_err(|_| VaultError)?
    }
}

pub struct OrgTenant {
    pub org: OrgId,
    pub org_uuid: Uuid,
    pub actor: UserId,
    pub principal: Principal,
    pub rt: PgPool,
    pub hr: HrService,
}

pub async fn seed_tenant(owner: &PgPool, tag: &str, vault: Arc<TestEnvVault>) -> OrgTenant {
    let org = OrgId::new();
    let org_uuid = *org.as_uuid();
    let actor = seed_org_and_super_admin(owner, org_uuid, tag).await;
    let rt = runtime_role_pool(owner).await;
    let principal = Principal::new(
        actor,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let hr = HrService::new(rt.clone()).with_rrn_vault(Some(vault));
    OrgTenant {
        org,
        org_uuid,
        actor,
        principal,
        rt,
        hr,
    }
}

pub async fn seed_employee(owner: &PgPool, org: Uuid, number: &str, name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, employee_number, source_filename, \
         source_sheet, source_row, source_key, hire_date) \
         VALUES ($1, 'Co', $2, $3, 'sheet.xlsx', 'S', 1, $4, '2026-09-01') RETURNING id",
    )
    .bind(org)
    .bind(name)
    .bind(number)
    .bind(Uuid::new_v4().to_string())
    // rls-arming: ok test fixture seeds employee as owner
    .fetch_one(owner)
    .await
    .unwrap()
}

pub async fn seed_import_run(owner: &PgPool, org: Uuid) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO data_import_runs (org_id, entity_type, status, source_filename, \
         source_format, source_sha256, pay_period_start, pay_period_end) \
         VALUES ($1, 'employee_hr', 'PREVIEWED', 'test.xlsx', 'xlsx', repeat('a', 64), \
                 CURRENT_DATE, CURRENT_DATE) RETURNING id",
    )
    .bind(org)
    // rls-arming: ok test fixture seeds import run as owner
    .fetch_one(owner)
    .await
    .unwrap()
}

pub async fn insert_v1_employee_rrn(
    owner: &PgPool,
    org: Uuid,
    employee: Uuid,
    actor: Uuid,
    sealed: &SealedRrn,
) {
    sqlx::query(
        "INSERT INTO employee_rrn (org_id, employee_id, rrn_hmac, hmac_key_version, \
         rrn_hmac_v2, blind_index_version, ciphertext, nonce, dek_wrapped, dek_nonce, \
         key_version, masked, alg_id, kek_id, msg_id, commitment_tag, source, recorded_by) \
         VALUES ($1,$2,$3,1,NULL,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'FORM',$14)",
    )
    .bind(org)
    .bind(employee)
    .bind(&sealed.hmac)
    .bind(&sealed.ciphertext)
    .bind(&sealed.nonce)
    .bind(&sealed.dek_wrapped)
    .bind(&sealed.dek_nonce)
    .bind(sealed.key_version)
    .bind(&sealed.masked)
    .bind(sealed.alg_id.as_deref())
    .bind(sealed.kek_id.as_deref())
    .bind(sealed.msg_id.as_deref())
    .bind(sealed.commitment_tag.as_deref())
    .bind(actor)
    // rls-arming: ok test fixture seeds legacy v1 employee_rrn row as owner
    .execute(owner)
    .await
    .unwrap();
}
