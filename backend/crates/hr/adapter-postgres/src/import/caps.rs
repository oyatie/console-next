//! IMPORT-2: the registry values an import reads — the workbook caps
//! (platform switches) and the tenant's import policy.

use std::collections::BTreeMap;

use console_hr_domain::import::guard::WorkbookCaps;
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::Postgres;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::lifecycle::title_reason::coded;
use crate::{HrError, HrService};

const MIB: u64 = 1 << 20;

const CAP_KEYS: [SettingKey; 6] = [
    SettingKey::ImportUploadMaxMib,
    SettingKey::ImportZipMaxEntries,
    SettingKey::ImportZipMaxExpandedMib,
    SettingKey::ImportZipMaxRatio,
    SettingKey::ImportSheetMaxGridCells,
    SettingKey::ImportWorkbookMaxCells,
];

/// The resolved values of `keys` in the armed transaction.
pub async fn settings_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    keys: &[SettingKey],
) -> Result<BTreeMap<SettingKey, SettingValue>, HrError> {
    // The database clock: `effective_from` is stamped with it, so an app
    // clock behind the database's would not see an override set just now.
    let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await?;
    let resolved = resolve_in_tx(tx.as_mut(), OrgId::from_uuid(org), keys, None, now)
        .await
        .map_err(coded)?;
    keys.iter()
        .map(|key| match resolved.get(key) {
            Some(Ok(value)) => Ok((*key, value.value)),
            _ => Err(HrError::internal(format!(
                "setting {} did not resolve",
                key.as_str()
            ))),
        })
        .collect()
}

fn caps_from(values: impl Fn(SettingKey) -> Option<i64>) -> Result<WorkbookCaps, HrError> {
    let int = |key: SettingKey| {
        values(key)
            .and_then(|v| u64::try_from(v).ok())
            .ok_or_else(|| HrError::internal(format!("setting {} is not a count", key.as_str())))
    };
    Ok(WorkbookCaps {
        max_upload_bytes: int(SettingKey::ImportUploadMaxMib)? * MIB,
        max_entries: usize::try_from(int(SettingKey::ImportZipMaxEntries)?)
            .map_err(|_| HrError::internal("import.zip.max_entries does not fit"))?,
        max_expanded_bytes: int(SettingKey::ImportZipMaxExpandedMib)? * MIB,
        max_ratio: int(SettingKey::ImportZipMaxRatio)?,
        max_grid_cells: int(SettingKey::ImportSheetMaxGridCells)?,
        max_cells: int(SettingKey::ImportWorkbookMaxCells)?,
    })
}

/// The registry defaults: the router's body limit, before any tenant is known.
///
/// # Errors
/// Only if a cap key lost its integer default (a registry bug).
pub fn default_caps() -> Result<WorkbookCaps, HrError> {
    caps_from(|key| key.def().default.and_then(SettingValue::as_int))
}

impl HrService {
    /// The caps an upload of this tenant is held to.
    pub async fn workbook_caps(&self, org: OrgId) -> Result<WorkbookCaps, HrError> {
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let values = settings_in_tx(tx, *org.as_uuid(), &CAP_KEYS).await?;
                caps_from(|key| values.get(&key).and_then(|v| v.as_int()))
            })
        })
        .await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_registry_defaults_in_bytes() {
        let caps = default_caps().unwrap();
        assert_eq!(caps.max_upload_bytes, 16 * MIB);
        assert_eq!(caps.max_expanded_bytes, 128 * MIB);
        assert_eq!(caps.max_entries, 1_000);
    }
}
