// SPDX-License-Identifier: LicenseRef-Proprietary
//! Resolve the registration's calendar at the transaction clock and legal-entity scope.
use console_kernel_core::KernelError;
use console_settings_domain::{OverrideRow, SettingKey, resolve};
use sqlx::Row;
use uuid::Uuid;

use crate::{PgEntityError, Tx};

pub(crate) async fn today(tx: &mut Tx<'_>, entity: Uuid) -> Result<time::Date, PgEntityError> {
    let key = SettingKey::CalendarTimeZone;
    let stored = sqlx::query(
        "SELECT id, scope_entity_id, value, effective_from FROM tenant_setting_overrides \
         WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid \
           AND key = $1 AND (scope_entity_id IS NULL OR scope_entity_id = $2)",
    )
    .bind(key.as_str())
    .bind(entity)
    .fetch_all(tx.as_mut())
    .await?;
    let mut rows = Vec::new();
    for row in stored {
        rows.push(OverrideRow {
            id: row.try_get("id")?,
            scope_entity_id: row.try_get("scope_entity_id")?,
            value: key
                .def()
                .parse(&row.try_get("value")?)
                .ok_or_else(|| KernelError::internal("stored calendar.time_zone does not parse"))?,
            effective_from: row.try_get("effective_from")?,
        });
    }
    let now = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await?;
    let resolved = resolve(key, &rows, Some(entity), now).map_err(KernelError::from)?;
    let zone = resolved
        .value
        .as_code()
        .ok_or_else(|| KernelError::internal("calendar.time_zone is not a code"))?;
    Ok(sqlx::query_scalar("SELECT (now() AT TIME ZONE $1)::date")
        .bind(zone)
        .fetch_one(tx.as_mut())
        .await?)
}
