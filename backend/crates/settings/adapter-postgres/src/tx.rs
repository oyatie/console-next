//! The [`SettingsStore`] port on one armed transaction. The `BEFORE INSERT`
//! trigger is the authority on the change rules; a refusal it raises (a race
//! with a concurrent change, or onboarding ending) maps back to the same coded
//! [`SettingError`] the domain check returns.

use crate::read::{db_error, load_rows_in_tx, parse_direction};
use crate::reason_codes::validate_reason_in_tx;
use console_kernel_core::{KernelError, OrgId, Timestamp};
use console_settings_application::{
    Actor, ChangeError, InsertedOverride, NewOverride, SettingsStore, StoreFacts,
};
use console_settings_domain::code_lists::{ReasonDomain, ValidReason};
use console_settings_domain::{
    LOOSENING_DELAY, OverrideRow, SettingError, SettingKey, SettingValue,
};
use sha2::Digest;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(crate) struct PgSettingsTx<'a, 'c> {
    pub(crate) tx: &'a mut Transaction<'c, Postgres>,
    pub(crate) org: OrgId,
}

#[must_use]
pub fn settings_change_payload(key: SettingKey, value: &SettingValue) -> String {
    serde_json::json!({
        "key": key.as_str(),
        "value": value,
    })
    .to_string()
}

impl SettingsStore for PgSettingsTx<'_, '_> {
    async fn facts(&mut self) -> Result<StoreFacts, KernelError> {
        let row = sqlx::query(
            "SELECT clock_timestamp() AS now, tenant_setting_onboarding($1) AS onboarding",
        )
        .bind(self.org.as_uuid())
        .fetch_one(self.tx.as_mut())
        .await
        .map_err(db_error)?;
        Ok(StoreFacts {
            now: row.try_get("now").map_err(db_error)?,
            onboarding: row.try_get("onboarding").map_err(db_error)?,
        })
    }

    async fn validate_reason(
        &mut self,
        code: &str,
        note: Option<&str>,
    ) -> Result<ValidReason, KernelError> {
        validate_reason_in_tx(
            self.tx.as_mut(),
            self.org,
            ReasonDomain::SettingsChange,
            code,
            note,
        )
        .await
    }

    async fn resolve_step_up(
        &mut self,
        actor: Actor,
        ceremony_id: Option<Uuid>,
        scope_entity_id: Option<Uuid>,
        key: SettingKey,
        value: &SettingValue,
    ) -> Result<bool, KernelError> {
        let Some(ceremony_id) = ceremony_id else {
            return Ok(false);
        };
        let object_id = scope_entity_id.unwrap_or(Uuid::nil());
        let payload = settings_change_payload(key, value);
        let payload_hash = hex::encode(sha2::Sha256::digest(payload.as_bytes()));
        let verified: Option<Uuid> = sqlx::query_scalar(
            "SELECT ceremony_id FROM step_up_assertions \
             WHERE org_id = $1 AND ceremony_id = $2 AND user_id = $3 \
               AND action_kind = 'SETTINGS_CHANGE' AND object_id = $4 AND payload_hash = $5",
        )
        .bind(self.org.as_uuid())
        .bind(ceremony_id)
        .bind(actor.user.as_uuid())
        .bind(object_id)
        .bind(&payload_hash)
        .fetch_optional(self.tx.as_mut())
        .await
        .map_err(db_error)?;
        Ok(verified.is_some())
    }

    async fn rows(
        &mut self,
        key: SettingKey,
        entity: Option<Uuid>,
    ) -> Result<(Vec<Uuid>, Vec<OverrideRow>), KernelError> {
        if let Some(entity) = entity {
            let live: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM legal_entities e WHERE e.org_id=$1 AND e.id=$2
                   AND e.voided_at IS NULL AND e.closed_on IS NULL
                 UNION ALL SELECT 1 FROM workplaces w JOIN legal_entities e
                   ON e.org_id=w.org_id AND e.id=w.legal_entity_id
                 WHERE w.org_id=$1 AND w.id=$2 AND w.voided_at IS NULL
                   AND w.closed_on IS NULL
                   AND e.voided_at IS NULL AND e.closed_on IS NULL)",
            )
            .bind(self.org.as_uuid())
            .bind(entity)
            .fetch_one(self.tx.as_mut())
            .await
            .map_err(db_error)?;
            if !live {
                tracing::warn!(code = "setting_scope_unknown", "settings scope refused");
                return Err(KernelError::validation("unknown or inactive setting scope")
                    .with_code("setting_scope_unknown")
                    .with_field("scope_entity_id"));
            }
        }
        let (chain, mut rows) = load_rows_in_tx(self.tx.as_mut(), self.org, &[key], entity).await?;
        Ok((chain, rows.remove(&key).unwrap_or_default()))
    }

    async fn insert(&mut self, row: NewOverride) -> Result<InsertedOverride, ChangeError> {
        let value =
            serde_json::to_value(row.value).map_err(|e| KernelError::internal(e.to_string()))?;
        let inserted = sqlx::query(
            "INSERT INTO tenant_setting_overrides
                 (org_id, scope_entity_id, key, value, effective_from, set_by,
                  reason_code, reason_note, step_up_assertion_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, direction, onboarding_exempt",
        )
        .bind(self.org.as_uuid())
        .bind(row.scope_entity_id)
        .bind(row.key.as_str())
        .bind(value)
        .bind(row.effective_from)
        .bind(row.set_by.as_uuid())
        .bind(&row.reason_code)
        .bind(&row.reason_note)
        .bind(row.step_up_assertion_id)
        .fetch_one(self.tx.as_mut())
        .await
        .map_err(|e| insert_error(&row, e))?;
        let direction: String = inserted.try_get("direction").map_err(db_error)?;
        Ok(InsertedOverride {
            id: inserted.try_get("id").map_err(db_error)?,
            direction: parse_direction(&direction),
            onboarding_exempt: inserted.try_get("onboarding_exempt").map_err(db_error)?,
        })
    }

    async fn keeps_own_value(
        &mut self,
        key: SettingKey,
        entity: Option<Uuid>,
        as_of: Timestamp,
    ) -> Result<Vec<Uuid>, KernelError> {
        sqlx::query_scalar(
            "SELECT DISTINCT scope_entity_id FROM tenant_setting_overrides
             WHERE org_id = $1 AND key = $2 AND effective_from <= $4
               AND scope_entity_id IS NOT NULL AND scope_entity_id IS DISTINCT FROM $3
               AND ($3::uuid IS NULL OR scope_entity_id IN
                   (SELECT id FROM workplaces WHERE org_id = $1 AND legal_entity_id = $3))
             ORDER BY scope_entity_id",
        )
        .bind(self.org.as_uuid())
        .bind(key.as_str())
        .bind(entity)
        .bind(as_of)
        .fetch_all(self.tx.as_mut())
        .await
        .map_err(db_error)
    }
}

fn insert_error(row: &NewOverride, error: sqlx::Error) -> ChangeError {
    let key = row.key;
    if matches!(&error, sqlx::Error::Database(db) if db.message() == "setting_scope_unknown") {
        return KernelError::validation("unknown or inactive setting scope")
            .with_code("setting_scope_unknown")
            .with_field("scope_entity_id")
            .into();
    }
    if let sqlx::Error::Database(db) = &error {
        match db.code().as_deref() {
            Some("23514") => {
                let refusal = match db.message() {
                    "setting_not_editable" => Some(SettingError::NotEditable(key)),
                    "setting_unknown_key" | "setting_value_invalid" => {
                        Some(SettingError::InvalidValue(key))
                    }
                    "setting_out_of_range" => Some(SettingError::OutOfRange(key)),
                    "setting_backdated" => Some(SettingError::Backdated(key)),
                    "setting_loosening_delay" => Some(SettingError::LooseningTooSoon {
                        key,
                        earliest: row.now + LOOSENING_DELAY,
                    }),
                    _ => None,
                };
                if let Some(refusal) = refusal {
                    return refusal.into();
                }
            }
            Some("23505") => {
                return KernelError::conflict(
                    "a value for this setting already takes effect at that time",
                )
                .with_code("setting_effective_from_taken")
                .with_field("effective_from")
                .into();
            }
            _ => {}
        }
    }
    db_error(error).into()
}
