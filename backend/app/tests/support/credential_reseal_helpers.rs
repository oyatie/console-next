// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_comms_adapter_postgres::PgMailStore;
use console_comms_application::{Aad, CredentialCipher, EmailAccountId, MailStore};
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::rrn::{FieldRevealRequest, RevealField, reveal_binding};
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{MobilePasskeyStepUpAssertion, MobilePasskeyStepUpEnvelope};
use console_platform_authz::Principal;
use console_platform_request_context::CURRENT_ORG;
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use serde_json::json;
use sqlx::PgPool;
use std::io::Write;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct LogSink(pub Arc<Mutex<Vec<u8>>>);
impl Write for LogSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogSink {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

pub fn keyring_json(active: &str, keys: &[(&str, u8)]) -> String {
    let entries: Vec<String> = keys
        .iter()
        .map(|(id, byte)| format!(r#""{id}":"{}""#, BASE64.encode([*byte; 32])))
        .collect();
    format!(
        r#"{{"active":"{active}","keys":{{{}}}}}"#,
        entries.join(",")
    )
}

pub fn seal_rrn_with_suite(
    vault: &super::rrn_support::TestEnvVault,
    org_uuid: Uuid,
    raw_rrn: &str,
    suite: i16,
) -> SealedRrn {
    let rrn = Rrn::parse(raw_rrn).unwrap();
    let mut sealed = vault.seal(org_uuid, &rrn).unwrap();
    if suite != 3 {
        let org_str = org_uuid.to_string();
        let cred = vault
            .cipher
            .encrypt_with_suite(
                suite,
                rrn.digits().as_bytes(),
                Aad {
                    org_id: &org_str,
                    account_id: "employee_rrn",
                    field: "rrn",
                },
            )
            .unwrap();
        sealed.ciphertext = cred.ciphertext;
        sealed.nonce = cred.nonce;
        sealed.dek_wrapped = cred.dek_wrapped;
        sealed.dek_nonce = cred.dek_nonce;
        sealed.key_version = cred.key_version;
        sealed.alg_id = cred.alg_id;
        sealed.kek_id = cred.kek_id;
        sealed.msg_id = cred.msg_id;
        sealed.commitment_tag = cred.commitment_tag;
    }
    sealed
}

pub async fn seed_mail_account(
    owner: &PgPool,
    org: OrgId,
    actor: UserId,
    addr: &str,
    cipher: &EnvelopeCredentialCipher,
    smtp_suite: i16,
    imap_suite: i16,
) -> EmailAccountId {
    let id = EmailAccountId::new();
    let (org_s, id_s) = (org.to_string(), id.to_string());
    let smtp = cipher
        .encrypt_with_suite(
            smtp_suite,
            b"smtp-secret-pass",
            Aad {
                org_id: &org_s,
                account_id: &id_s,
                field: "smtp_password",
            },
        )
        .unwrap();
    let imap = cipher
        .encrypt_with_suite(
            imap_suite,
            b"imap-secret-pass",
            Aad {
                org_id: &org_s,
                account_id: &id_s,
                field: "imap_password",
            },
        )
        .unwrap();
    sqlx::query(
        "INSERT INTO email_accounts (id, org_id, display_name, email_address, \
         imap_host, imap_port, imap_security, imap_username, \
         smtp_host, smtp_port, smtp_security, smtp_username, \
         smtp_password_ct, smtp_password_nonce, dek_wrapped, dek_nonce, \
         imap_password_ct, imap_password_nonce, imap_dek_wrapped, imap_dek_nonce, \
         key_version, created_by, imap_key_version, alg_id, kek_id, smtp_msg_id, \
         smtp_commitment_tag, imap_alg_id, imap_kek_id, imap_msg_id, imap_commitment_tag) \
         VALUES ($1,$2,'Ops',$3,'imap.example.com',993,'TLS','ops',\
         'smtp.example.com',587,'STARTTLS','ops',$4,$5,$6,$7,$8,$9,$10,$11,\
         $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)",
    )
    .bind(*id.as_uuid())
    .bind(*org.as_uuid())
    .bind(addr)
    .bind(&smtp.ciphertext)
    .bind(&smtp.nonce)
    .bind(&smtp.dek_wrapped)
    .bind(&smtp.dek_nonce)
    .bind(&imap.ciphertext)
    .bind(&imap.nonce)
    .bind(&imap.dek_wrapped)
    .bind(&imap.dek_nonce)
    .bind(smtp.key_version)
    .bind(*actor.as_uuid())
    .bind(imap.key_version)
    .bind(smtp.alg_id.as_deref())
    .bind(smtp.kek_id.as_deref())
    .bind(smtp.msg_id.as_deref())
    .bind(smtp.commitment_tag.as_deref())
    .bind(imap.alg_id.as_deref())
    .bind(imap.kek_id.as_deref())
    .bind(imap.msg_id.as_deref())
    .bind(imap.commitment_tag.as_deref())
    .execute(owner)
    .await
    .unwrap();
    id
}

pub async fn seed_rrn_row(owner: &PgPool, org: Uuid, emp: Uuid, actor: Uuid, sealed: &SealedRrn) {
    sqlx::query(
        "INSERT INTO employee_rrn (org_id, employee_id, rrn_hmac, hmac_key_version, \
         rrn_hmac_v2, blind_index_version, ciphertext, nonce, dek_wrapped, dek_nonce, \
         key_version, masked, alg_id, kek_id, msg_id, commitment_tag, source, recorded_by) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'FORM',$17)",
    )
    .bind(org)
    .bind(emp)
    .bind(&sealed.hmac)
    .bind(sealed.hmac_key_version)
    .bind(sealed.hmac_v2.as_deref())
    .bind(sealed.blind_index_version)
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
    .execute(owner)
    .await
    .unwrap();
}

pub async fn reveal_with_step_up(
    pool: &PgPool,
    hr: &HrService,
    org: OrgId,
    actor: UserId,
    principal: Principal,
    emp: Uuid,
    vault: &dyn RrnVault,
) -> String {
    let mut key = SoftKey::enroll(pool, org, actor).await;
    let passkeys = passkey_service();
    let binding = reveal_binding(emp, "RRN", "IDENTITY_VERIFICATION");
    let start = passkeys
        .start_mobile_step_up(pool, *actor.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut ch = serde_json::to_value(start.challenge).unwrap();
    ch["publicKey"]["allowCredentials"] =
        json!([{ "type": "public-key", "id": key.credential_id() }]);
    let revealed = hr
        .reveal_field(
            principal,
            emp,
            FieldRevealRequest {
                field: RevealField::Rrn,
                reason_code: "IDENTITY_VERIFICATION".into(),
                note: None,
                step_up: Some(MobilePasskeyStepUpEnvelope {
                    binding,
                    assertion: MobilePasskeyStepUpAssertion {
                        ceremony_id: start.ceremony_id,
                        credential: serde_json::from_value(key.assert(&ch).unwrap()).unwrap(),
                    },
                }),
            },
            Some(vault),
            Some(&passkeys),
        )
        .await
        .unwrap();
    revealed.value.as_str().unwrap().to_owned()
}

pub async fn assert_mail_decrypts_and_cross_tenant_fails(
    store: &PgMailStore,
    org: OrgId,
    aid: EmailAccountId,
    cipher: &EnvelopeCredentialCipher,
) {
    let acc = CURRENT_ORG
        .scope(org, store.get_account())
        .await
        .unwrap()
        .unwrap();
    let (org_s, id_s) = (org.to_string(), acc.id.to_string());
    for (cred, field, expected) in [
        (&acc.smtp_password, "smtp_password", b"smtp-secret-pass"),
        (&acc.imap_password, "imap_password", b"imap-secret-pass"),
    ] {
        let aad = Aad {
            org_id: &org_s,
            account_id: &id_s,
            field,
        };
        assert_eq!(cipher.open_bytes(cred, aad).unwrap(), expected);
    }
    let bad_org = Uuid::new_v4().to_string();
    let aid_s = aid.to_string();
    let bad_aad = Aad {
        org_id: &bad_org,
        account_id: &aid_s,
        field: "smtp_password",
    };
    assert!(cipher.decrypt(&acc.smtp_password, bad_aad).is_err());
}

pub async fn assert_reseal_audits_and_zero_leakage(pool: &PgPool, sink: &LogSink) {
    use sqlx::Row;
    let audit_rows = sqlx::query(
        "SELECT actor, source, after_snap::text AS snap FROM audit_events \
         WHERE action IN ('employee.rrn_envelope_reseal','import.staged_identity_envelope_reseal','email.account_credential_reseal')",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(audit_rows.len(), 6);
    for row in &audit_rows {
        assert!(row.get::<Option<Uuid>, _>("actor").is_none());
        assert_eq!(row.get::<String, _>("source"), "SCHEDULER");
        let snap: String = row.get("snap");
        assert!(
            snap.contains("k2") && !snap.contains("900101") && !snap.contains("smtp-secret-pass")
        );
    }
    let logs = String::from_utf8_lossy(&sink.0.lock().unwrap()).into_owned();
    for secret in [
        "smtp-secret-pass",
        "imap-secret-pass",
        "900101",
        "1234567",
        "910202",
    ] {
        assert!(!logs.contains(secret));
    }
}
