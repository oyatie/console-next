// SPDX-License-Identifier: LicenseRef-Proprietary
//! Resolved rollback policy shared by each page of immutable run records.
use crate::HrError;
use console_settings_domain::{SettingKey, SettingValue};
use time::OffsetDateTime;
use uuid::Uuid;
pub(super) struct ReadPolicy {
    pub(super) setup: bool,
    pub(super) window_days: i64,
    pub(super) routed: bool,
    pub(super) now: OffsetDateTime,
}

pub(super) async fn policy_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
) -> Result<ReadPolicy, HrError> {
    let keys = [
        SettingKey::ImportRollbackWindowDays,
        SettingKey::ApprovalPolicyImportRollback,
    ];
    let values = crate::import::caps::settings_in_tx(tx, org, &keys).await?;
    let window_days = values
        .get(&keys[0])
        .and_then(|v| v.as_int())
        .ok_or_else(|| HrError::internal("rollback window did not resolve"))?;
    let routed = match values.get(&keys[1]) {
        Some(SettingValue::Code("route")) => true,
        Some(SettingValue::Code("none")) => false,
        _ => {
            return Err(HrError::internal(
                "rollback approval policy did not resolve",
            ));
        }
    };
    let (setup, now): (bool, OffsetDateTime) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM tenant_phase WHERE org_id = $1 AND phase = 'SETUP'), now()",
    )
    .bind(org)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(ReadPolicy {
        setup,
        window_days,
        routed,
        now,
    })
}
