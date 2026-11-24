// SPDX-License-Identifier: LicenseRef-Proprietary
//! Payroll record storage behind the canonical Cedar fact loader.
use console_kernel_core::{KernelError, OrgId};
use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::visible::{
    DecisionFacts, PayGroupFact, PayGroupFactLoader, PayrollModuleFactLoader, load_facts,
};
use console_platform_db::settings_read::{SettingKey, SettingValue, resolve_in_tx};
use sqlx::{Postgres, Transaction};

use crate::lifecycle::LifecycleError;
use crate::pay_run::PayRunError;
use crate::{PgPayrollError, PgPayrollStore};

/// Pay-group facts read through the caller's tenant transaction, for callers
/// that hold no store.
#[derive(Debug, Clone, Copy)]
pub struct RlsPayGroupFacts;

impl PayGroupFactLoader for PgPayrollStore {
    async fn load_pay_group_facts(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
    ) -> Result<Vec<PayGroupFact>, KernelError> {
        RlsPayGroupFacts.load_pay_group_facts(tx, org).await
    }
}

impl PayGroupFactLoader for RlsPayGroupFacts {
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
        let groups: Vec<(uuid::Uuid, uuid::Uuid, Option<bool>)> =
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
                sensitive: sensitive.unwrap_or(true),
            })
            .collect())
    }
}

/// The pay group a run belongs to: `None` for a run that does not exist (or is
/// another org's), `Some(None)` for a run staged from imports.
pub async fn run_pay_group_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: uuid::Uuid,
) -> Result<Option<Option<uuid::Uuid>>, PgPayrollError> {
    Ok(
        sqlx::query_scalar("SELECT pay_group_id FROM payroll_draft_runs WHERE id=$1")
            .bind(run_id)
            .fetch_optional(tx.as_mut())
            .await?,
    )
}

/// A command from a surface that skips the REST pay gate (the ontology action
/// path) reaches a pay group's run only with tenant pay:edit and then that
/// group's run access, sensitive clearance included; otherwise it answers as a
/// run that does not exist. A run staged from imports needs tenant pay:edit only.
pub(crate) async fn require_run_command_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: uuid::Uuid,
    run_id: uuid::Uuid,
) -> Result<(), PayRunError> {
    let Some(group) = run_pay_group_in_tx(tx, run_id)
        .await
        .map_err(KernelError::from)?
    else {
        // An unknown run: the lifecycle answers NotFound.
        return Ok(());
    };
    let facts = load_facts(tx, org, actor).await?;
    match manageable_pay_groups_in_tx(tx, &facts, org).await? {
        Some(groups) if group.is_none_or(|group| groups.contains(&group)) => Ok(()),
        _ => Err(LifecycleError::NotFound.into()),
    }
}

/// The pay groups whose runs `facts`' holder may submit or decide, or `None`
/// without tenant pay:edit. A run outside them would open as a missing run.
pub async fn manageable_pay_groups_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    facts: &DecisionFacts,
    org: OrgId,
) -> Result<Option<Vec<uuid::Uuid>>, KernelError> {
    let manage = Feature::PayrollRunManage;
    let tenant = NodeRef {
        kind: NodeKind::Tenant,
        id: *org.as_uuid(),
    };
    if !facts
        .authorize(manage.as_str(), tenant)
        .map_err(|_| KernelError::unavailable("payroll run decision unavailable"))?
    {
        return Ok(None);
    }
    let groups = facts.visible_pay_groups(tx, manage, &RlsPayGroupFacts);
    groups.await.map(Some)
}

impl PayrollModuleFactLoader for PgPayrollStore {
    async fn payroll_enabled(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
    ) -> Result<bool, KernelError> {
        let armed: bool = sqlx::query_scalar(
            "SELECT COALESCE(current_setting('app.current_org', true)=$1,false)
             AND row_security_active('tenant_setting_overrides')",
        )
        .bind(org.to_string())
        .fetch_one(tx.as_mut())
        .await
        .map_err(db)?;
        if !armed {
            return Err(KernelError::forbidden(
                "payroll module facts require tenant RLS",
            ));
        }
        let key = SettingKey::ModulePayrollEnabled;
        let settings = resolve_in_tx(
            tx.as_mut(),
            org,
            &[key],
            None,
            time::OffsetDateTime::now_utc(),
        )
        .await?;
        Ok(settings
            .get(&key)
            .and_then(|value| value.as_ref().ok())
            .is_some_and(|value| value.value == SettingValue::Bool(true)))
    }
}

fn db(error: sqlx::Error) -> KernelError {
    KernelError::internal(format!("Cedar facts unavailable: {error}"))
}
