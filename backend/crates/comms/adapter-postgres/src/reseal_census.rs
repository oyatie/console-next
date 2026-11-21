// SPDX-License-Identifier: LicenseRef-Proprietary
//! RLS-armed envelope version and KEK-rotation census queries for `email_accounts`.

use console_comms_application::CredentialCipher;
use console_kernel_core::{KernelError, OrgId};
use console_platform_db::with_org_conn;
use sqlx::Row;
use uuid::Uuid;

use crate::{PgMailError, PgMailStore};

/// Per-credential-slot envelope counts on `email_accounts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EmailCredentialCensus {
    pub v1: i64,
    pub v2: i64,
    pub v3_stale_kek: i64,
    pub v3_current: i64,
    pub other: i64,
}

impl EmailCredentialCensus {
    #[must_use]
    pub const fn legacy_remaining(&self) -> i64 {
        self.v1 + self.v2 + self.other
    }

    #[must_use]
    pub const fn reseal_pending(&self) -> i64 {
        self.v1 + self.v2 + self.v3_stale_kek + self.other
    }

    fn add_assign(&mut self, rhs: Self) {
        self.v1 += rhs.v1;
        self.v2 += rhs.v2;
        self.v3_stale_kek += rhs.v3_stale_kek;
        self.v3_current += rhs.v3_current;
        self.other += rhs.other;
    }
}

/// Combined SMTP and IMAP envelope census across `email_accounts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EmailEnvelopeCensus {
    pub smtp: EmailCredentialCensus,
    pub imap: EmailCredentialCensus,
}

impl PgMailStore {
    /// Aggregate legacy and stale-KEK envelope counts across all organizations.
    pub async fn legacy_envelope_census(
        &self,
        target_alg_id: &str,
        target_kek_id: &str,
    ) -> Result<EmailEnvelopeCensus, PgMailError> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org count below runs under with_org_conn
            .fetch_all(&self.pool)
            .await?;
        let mut total = EmailEnvelopeCensus::default();
        for org_uuid in orgs {
            let org_census = self
                .legacy_envelope_census_in_org(
                    OrgId::from_uuid(org_uuid),
                    target_alg_id,
                    target_kek_id,
                )
                .await?;
            total.smtp.add_assign(org_census.smtp);
            total.imap.add_assign(org_census.imap);
        }
        Ok(total)
    }

    /// Aggregate legacy and stale-KEK envelope counts across all organizations,
    /// resolving per-tenant target KEKs when supported by `cipher`.
    pub async fn legacy_envelope_census_with_cipher(
        &self,
        cipher: &dyn CredentialCipher,
    ) -> Result<EmailEnvelopeCensus, PgMailError> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org count below runs under with_org_conn
            .fetch_all(&self.pool)
            .await?;
        let target_alg_id = cipher.active_alg_id().unwrap_or("");
        let mut total = EmailEnvelopeCensus::default();
        for org_uuid in orgs {
            let target_kek = cipher.target_kek_for_org(org_uuid).await.map_err(|_| {
                PgMailError::Domain(KernelError::internal("credential cipher census failed"))
            })?;
            let target_kek_id = target_kek.as_deref().unwrap_or("");
            let org_census = self
                .legacy_envelope_census_in_org(
                    OrgId::from_uuid(org_uuid),
                    target_alg_id,
                    target_kek_id,
                )
                .await?;
            total.smtp.add_assign(org_census.smtp);
            total.imap.add_assign(org_census.imap);
        }
        Ok(total)
    }

    /// Query SMTP and IMAP envelope counts for a single organization.
    pub async fn legacy_envelope_census_in_org(
        &self,
        org: OrgId,
        target_alg_id: &str,
        target_kek_id: &str,
    ) -> Result<EmailEnvelopeCensus, PgMailError> {
        let org_uuid = *org.as_uuid();
        let alg = target_alg_id.to_owned();
        let kek = target_kek_id.to_owned();
        with_org_conn::<_, _, PgMailError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT \
                        COUNT(*) FILTER (WHERE key_version = 1) AS smtp_v1, \
                        COUNT(*) FILTER (WHERE key_version = 2) AS smtp_v2, \
                        COUNT(*) FILTER (WHERE key_version = 3 AND (alg_id IS DISTINCT FROM $2 OR kek_id IS DISTINCT FROM $3)) AS smtp_v3_stale, \
                        COUNT(*) FILTER (WHERE key_version = 3 AND alg_id = $2 AND kek_id = $3) AS smtp_v3_current, \
                        COUNT(*) FILTER (WHERE key_version NOT IN (1, 2, 3)) AS smtp_other, \
                        COUNT(*) FILTER (WHERE imap_key_version = 1) AS imap_v1, \
                        COUNT(*) FILTER (WHERE imap_key_version = 2) AS imap_v2, \
                        COUNT(*) FILTER (WHERE imap_key_version = 3 AND (imap_alg_id IS DISTINCT FROM $2 OR imap_kek_id IS DISTINCT FROM $3)) AS imap_v3_stale, \
                        COUNT(*) FILTER (WHERE imap_key_version = 3 AND imap_alg_id = $2 AND imap_kek_id = $3) AS imap_v3_current, \
                        COUNT(*) FILTER (WHERE imap_key_version NOT IN (1, 2, 3)) AS imap_other \
                     FROM email_accounts \
                     WHERE org_id = $1",
                )
                .bind(org_uuid)
                .bind(&alg)
                .bind(&kek)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(EmailEnvelopeCensus {
                    smtp: EmailCredentialCensus {
                        v1: row.try_get("smtp_v1")?,
                        v2: row.try_get("smtp_v2")?,
                        v3_stale_kek: row.try_get("smtp_v3_stale")?,
                        v3_current: row.try_get("smtp_v3_current")?,
                        other: row.try_get("smtp_other")?,
                    },
                    imap: EmailCredentialCensus {
                        v1: row.try_get("imap_v1")?,
                        v2: row.try_get("imap_v2")?,
                        v3_stale_kek: row.try_get("imap_v3_stale")?,
                        v3_current: row.try_get("imap_v3_current")?,
                        other: row.try_get("imap_other")?,
                    },
                })
            })
        })
        .await
    }
}
