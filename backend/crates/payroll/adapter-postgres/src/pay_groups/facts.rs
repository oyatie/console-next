// SPDX-License-Identifier: LicenseRef-Proprietary
//! Payroll record storage behind the canonical Cedar fact loader.
use console_kernel_core::{KernelError, OrgId};
use console_platform_authz::cedar_pbac::visible::{PayGroupFact, PayGroupFactLoader};
use sqlx::{Postgres, Transaction};

use crate::PgPayrollStore;

impl PayGroupFactLoader for PgPayrollStore {
    async fn load_pay_group_facts(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
    ) -> Result<Vec<PayGroupFact>, KernelError> {
        let armed: bool = sqlx::query_scalar(
            "SELECT COALESCE(current_setting('app.current_org', true)=$1,false)
             AND row_security_active('pay_groups')",
        )
        .bind(org.to_string())
        .fetch_one(tx.as_mut())
        .await
        .map_err(db)?;
        if !armed {
            return Err(KernelError::forbidden("pay-group facts require tenant RLS"));
        }
        let groups: Vec<(uuid::Uuid, uuid::Uuid, bool)> =
            sqlx::query_as("SELECT id,legal_entity_id,sensitive FROM pay_groups WHERE org_id=$1")
                .bind(org.as_uuid())
                .fetch_all(tx.as_mut())
                .await
                .map_err(db)?;
        Ok(groups
            .into_iter()
            .map(|(id, legal_entity_id, sensitive)| PayGroupFact {
                id,
                legal_entity_id,
                sensitive,
            })
            .collect())
    }
}

fn db(error: sqlx::Error) -> KernelError {
    KernelError::internal(format!("Cedar facts unavailable: {error}"))
}
