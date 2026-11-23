// SPDX-License-Identifier: LicenseRef-Proprietary
//! RLS-armed envelope version and KEK-rotation census queries for `employee_rrn`
//! and `data_import_row_identities`.

use console_hr_domain::import::rrn_value::RrnVault;
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use sqlx::Row;
use uuid::Uuid;

use crate::{HrError, HrService};

/// Per-table counts partitioned by envelope version and active KEK alignment.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TableEnvelopeCensus {
    pub v1: i64,
    pub v2: i64,
    pub v3_stale_kek: i64,
    pub v3_current: i64,
    pub other: i64,
}

impl TableEnvelopeCensus {
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

/// Combined RRN envelope census across durable and staged RRN tables.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RrnEnvelopeCensus {
    pub employee_rrn: TableEnvelopeCensus,
    pub data_import_row_identities: TableEnvelopeCensus,
}

impl HrService {
    /// Aggregate legacy and stale-KEK envelope counts across all organizations.
    pub async fn legacy_envelope_census(
        &self,
        target_alg_id: &str,
        target_kek_id: &str,
    ) -> Result<RrnEnvelopeCensus, HrError> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org count below runs under with_org_conn
            .fetch_all(&self.pool)
            .await?;
        let mut total = RrnEnvelopeCensus::default();
        for org_uuid in orgs {
            let org_census = self
                .legacy_envelope_census_in_org(
                    OrgId::from_uuid(org_uuid),
                    target_alg_id,
                    target_kek_id,
                )
                .await?;
            total.employee_rrn.add_assign(org_census.employee_rrn);
            total
                .data_import_row_identities
                .add_assign(org_census.data_import_row_identities);
        }
        Ok(total)
    }

    /// Aggregate legacy and stale-KEK envelope counts across all organizations,
    /// resolving per-tenant target KEKs when supported by `vault`.
    pub async fn legacy_envelope_census_with_vault(
        &self,
        vault: &dyn RrnVault,
    ) -> Result<RrnEnvelopeCensus, HrError> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org count below runs under with_org_conn
            .fetch_all(&self.pool)
            .await?;
        let target_alg_id = vault.active_alg_id().unwrap_or("");
        let mut total = RrnEnvelopeCensus::default();
        for org_uuid in orgs {
            let target_kek = vault
                .target_kek_for_org(org_uuid)
                .await
                .map_err(|_| super::unavailable())?;
            let target_kek_id = target_kek.as_deref().unwrap_or("");
            let org_census = self
                .legacy_envelope_census_in_org(
                    OrgId::from_uuid(org_uuid),
                    target_alg_id,
                    target_kek_id,
                )
                .await?;
            total.employee_rrn.add_assign(org_census.employee_rrn);
            total
                .data_import_row_identities
                .add_assign(org_census.data_import_row_identities);
        }
        Ok(total)
    }

    /// Query legacy and stale-KEK envelope counts for a single organization.
    pub async fn legacy_envelope_census_in_org(
        &self,
        org: OrgId,
        target_alg_id: &str,
        target_kek_id: &str,
    ) -> Result<RrnEnvelopeCensus, HrError> {
        let org_uuid = *org.as_uuid();
        let alg = target_alg_id.to_owned();
        let kek = target_kek_id.to_owned();
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let emp =
                    query_table_census(tx.as_mut(), "employee_rrn", org_uuid, &alg, &kek).await?;
                let staged = query_table_census(
                    tx.as_mut(),
                    "data_import_row_identities",
                    org_uuid,
                    &alg,
                    &kek,
                )
                .await?;
                Ok(RrnEnvelopeCensus {
                    employee_rrn: emp,
                    data_import_row_identities: staged,
                })
            })
        })
        .await
    }
}

async fn query_table_census(
    conn: &mut sqlx::PgConnection,
    table: &'static str,
    org_uuid: Uuid,
    target_alg_id: &str,
    target_kek_id: &str,
) -> Result<TableEnvelopeCensus, sqlx::Error> {
    let sql = match table {
        "employee_rrn" => {
            "SELECT \
                COUNT(*) FILTER (WHERE key_version = 1) AS v1, \
                COUNT(*) FILTER (WHERE key_version = 2) AS v2, \
                COUNT(*) FILTER (WHERE key_version = 3 AND (alg_id IS DISTINCT FROM $2 OR kek_id IS DISTINCT FROM $3)) AS v3_stale_kek, \
                COUNT(*) FILTER (WHERE key_version = 3 AND alg_id = $2 AND kek_id = $3) AS v3_current, \
                COUNT(*) FILTER (WHERE key_version NOT IN (1, 2, 3)) AS other \
             FROM employee_rrn \
             WHERE org_id = $1"
        }
        _ => {
            "SELECT \
                COUNT(*) FILTER (WHERE key_version = 1) AS v1, \
                COUNT(*) FILTER (WHERE key_version = 2) AS v2, \
                COUNT(*) FILTER (WHERE key_version = 3 AND (alg_id IS DISTINCT FROM $2 OR kek_id IS DISTINCT FROM $3)) AS v3_stale_kek, \
                COUNT(*) FILTER (WHERE key_version = 3 AND alg_id = $2 AND kek_id = $3) AS v3_current, \
                COUNT(*) FILTER (WHERE key_version NOT IN (1, 2, 3)) AS other \
             FROM data_import_row_identities \
             WHERE org_id = $1"
        }
    };
    let row = sqlx::query(sql)
        .bind(org_uuid)
        .bind(target_alg_id)
        .bind(target_kek_id)
        .fetch_one(conn)
        .await?;
    Ok(TableEnvelopeCensus {
        v1: row.try_get("v1")?,
        v2: row.try_get("v2")?,
        v3_stale_kek: row.try_get("v3_stale_kek")?,
        v3_current: row.try_get("v3_current")?,
        other: row.try_get("other")?,
    })
}
