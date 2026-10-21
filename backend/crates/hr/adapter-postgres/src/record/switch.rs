//! The per-section tenant switches (`hr.record.<section>.enabled`,
//! 개인정보 보호법 §16①), read in the caller's transaction.
//!
//! the tenant-row SELECT mirrors settings-adapter-postgres
//! `load_rows_in_tx` (hr-adapter → settings-adapter is an illegal edge, the
//! G18 / PA-ENT precedent); ADR-006 moves that read to platform-db.

use console_hr_domain::record::Section;
use console_kernel_core::Timestamp;
use console_settings_domain::{OverrideRow, SettingKey, SettingValue, resolve};
use sqlx::{Postgres, Row, Transaction};

use super::SectionState;
use crate::HrError;

const fn key(section: Section) -> SettingKey {
    match section {
        Section::Education => SettingKey::HrRecordEducationEnabled,
        Section::Qualification => SettingKey::HrRecordQualificationEnabled,
        Section::Military => SettingKey::HrRecordMilitaryEnabled,
        Section::Training => SettingKey::HrRecordTrainingEnabled,
        Section::Language => SettingKey::HrRecordLanguageEnabled,
        Section::Award => SettingKey::HrRecordAwardEnabled,
        Section::Discipline => SettingKey::HrRecordDisciplineEnabled,
        Section::Family => SettingKey::HrRecordFamilyEnabled,
        Section::Disability => SettingKey::HrRecordDisabilityEnabled,
        Section::Veteran => SettingKey::HrRecordVeteranEnabled,
    }
}

fn unreadable() -> HrError {
    HrError::internal("a stored record section switch does not parse")
}

/// Every section's switch in force now. A stored value that does not parse
/// is an error, never the default. "Now" is the database clock, the one the
/// override trigger stamps `effective_from` with.
pub(crate) async fn section_states(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<SectionState>, HrError> {
    let wire: Vec<&str> = Section::ALL.iter().map(|s| key(*s).as_str()).collect();
    let rows = sqlx::query(
        "SELECT id, key, value, effective_from FROM tenant_setting_overrides \
         WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid \
           AND key = ANY($1) AND scope_entity_id IS NULL",
    )
    .bind(&wire)
    .fetch_all(tx.as_mut())
    .await?;
    let now: Timestamp = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await?;
    let mut states = Vec::with_capacity(Section::ALL.len());
    for section in Section::ALL {
        let key = key(*section);
        let mut own = Vec::new();
        for row in rows.iter().filter(|r| {
            r.try_get::<String, _>("key")
                .is_ok_and(|k| k == key.as_str())
        }) {
            let raw: serde_json::Value = row.try_get("value")?;
            own.push(OverrideRow {
                id: row.try_get("id")?,
                scope_entity_id: None,
                value: key.def().parse(&raw).ok_or_else(unreadable)?,
                effective_from: row.try_get("effective_from")?,
            });
        }
        let value = resolve(key, &own, None, now)
            .map_err(|_| unreadable())?
            .value;
        states.push(SectionState {
            section: *section,
            enabled: value == SettingValue::Bool(true),
        });
    }
    Ok(states)
}

/// 409 `record_section_disabled` unless `section` is on for this tenant.
/// Whether `section` is on for this tenant now.
pub(crate) async fn enabled(
    tx: &mut Transaction<'_, Postgres>,
    section: Section,
) -> Result<bool, HrError> {
    Ok(section_states(tx)
        .await?
        .iter()
        .any(|s| s.section == section && s.enabled))
}

pub(crate) async fn require_enabled(
    tx: &mut Transaction<'_, Postgres>,
    section: Section,
) -> Result<(), HrError> {
    if enabled(tx, section).await? {
        return Ok(());
    }
    Err(disabled(section))
}

/// 409 `record_section_disabled`.
pub(crate) fn disabled(section: Section) -> HrError {
    HrError {
        status: http::StatusCode::CONFLICT,
        code: "record_section_disabled",
        message: format!(
            "the {} section is turned off for this organization; nothing was recorded",
            section.segment()
        ),
        refusals: None,
    }
}
