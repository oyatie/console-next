//! Settings registry (BW-00) on Postgres: the append-only, effective-dated
//! `tenant_setting_overrides` table, the in-transaction read path other
//! contexts resolve values with, and the facade the REST crate calls.
//!
//! Every query runs on an armed transaction (`with_org_conn` /
//! `with_audits`), so RLS scopes it to the caller's tenant.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod read;
mod reason_codes;
mod reason_stats;
mod reason_tx;
mod tx;

pub use read::{
    EffectiveSetting, LegalBasis, OverrideRecord, ResolvedSettings, ScheduledValue,
    approval_routes_in_tx, load_rows_in_tx, resolve_in_tx,
};
pub use reason_codes::{CatalogEntry, validate_reason_in_tx};
pub use reason_stats::{CodeCount, SourceStats};
pub use tx::settings_change_payload;

use console_kernel_core::{
    AuditRequestContext, KernelError, OrgId, SettingVersionId, Timestamp, TraceContext,
};
use console_platform_db::{DbError, with_audits, with_org_conn};
use console_settings_application::{
    Actor, ChangeError, ChangeFacts, ChangeSetting, SettingChangePlan, SettingChangeView,
    change_setting, plan_setting,
};
use console_settings_domain::SettingKey;
use sqlx::PgPool;
use uuid::Uuid;

/// A refusal or failure from the facade: a coded domain/rule error, or a
/// transaction-level database failure.
#[derive(Debug)]
pub enum PgSettingsError {
    Domain(KernelError),
    TooSoon {
        error: KernelError,
        earliest: Timestamp,
    },
    Stale {
        error: KernelError,
        current_version: Option<SettingVersionId>,
    },
    Db(DbError),
}

impl From<ChangeError> for PgSettingsError {
    fn from(error: ChangeError) -> Self {
        match error {
            ChangeError::Refused(e) => Self::Domain(e),
            ChangeError::TooSoon { error, earliest } => Self::TooSoon { error, earliest },
            ChangeError::Stale {
                error,
                current_version,
            } => Self::Stale {
                error,
                current_version,
            },
        }
    }
}

impl From<KernelError> for PgSettingsError {
    fn from(error: KernelError) -> Self {
        Self::Domain(error)
    }
}

impl From<DbError> for PgSettingsError {
    fn from(error: DbError) -> Self {
        Self::Db(error)
    }
}

#[derive(Clone)]
pub struct PgSettingsStore {
    pool: PgPool,
}

impl PgSettingsStore {
    #[must_use]
    pub const fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub const fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Changes one setting in one audited transaction. `authorize` decides
    /// who may (Cedar `settings_change`) from the change's facts.
    ///
    /// # Errors
    /// See [`change_setting`]; database failures as [`PgSettingsError::Db`].
    pub async fn change_setting<A>(
        &self,
        actor: Actor,
        cmd: ChangeSetting,
        audit: (TraceContext, AuditRequestContext),
        authorize: A,
    ) -> Result<SettingChangeView, PgSettingsError>
    where
        A: FnOnce(&ChangeFacts) -> Result<(), KernelError> + Send + 'static,
    {
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                // Serialize every scope of a key: an inherited tenant value can also become stale.
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                    .bind(format!("console.settings|{}|{}", actor.org, cmd.key))
                    .execute(tx.as_mut())
                    .await
                    .map_err(DbError::Sqlx)?;
                let mut port = tx::PgSettingsTx { tx, org: actor.org };
                change_setting(&mut port, authorize, actor, cmd, audit)
                    .await
                    .map_err(PgSettingsError::from)
            })
        })
        .await
    }

    pub async fn plan_setting<A>(
        &self,
        actor: Actor,
        cmd: ChangeSetting,
        authorize: A,
    ) -> Result<SettingChangePlan, PgSettingsError>
    where
        A: FnOnce(&ChangeFacts) -> Result<(), KernelError> + Send + 'static,
    {
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let mut port = tx::PgSettingsTx { tx, org: actor.org };
                plan_setting(&mut port, authorize, actor, cmd, true)
                    .await
                    .map(|(plan, _)| plan)
                    .map_err(PgSettingsError::from)
            })
        })
        .await
    }

    /// Every key, resolved now for `entity` (or tenant-wide), with the rows
    /// scheduled to take effect later.
    ///
    /// # Errors
    /// Internal on a query failure or a stored value that no longer parses.
    pub async fn list_effective(
        &self,
        org: OrgId,
        entity: Option<Uuid>,
    ) -> Result<Vec<EffectiveSetting>, PgSettingsError> {
        with_org_conn(&self.pool, org, move |tx| {
            Box::pin(async move {
                let now: Timestamp = sqlx::query_scalar("SELECT now()")
                    .fetch_one(tx.as_mut())
                    .await
                    .map_err(DbError::Sqlx)?;
                let rows = load_rows_in_tx(tx.as_mut(), org, SettingKey::ALL, entity).await?;
                Ok(read::effective_settings(&rows, entity, now))
            })
        })
        .await
    }

    /// Every stored row of one key, all scopes, newest first.
    ///
    /// # Errors
    /// Internal on a query failure.
    pub async fn history(
        &self,
        org: OrgId,
        key: SettingKey,
    ) -> Result<Vec<OverrideRecord>, PgSettingsError> {
        with_org_conn(&self.pool, org, move |tx| {
            Box::pin(async move { Ok(read::history_in_tx(tx.as_mut(), org, key).await?) })
        })
        .await
    }
}
