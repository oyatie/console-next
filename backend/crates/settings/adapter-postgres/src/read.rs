//! Reads: the in-transaction read path every context uses, the resolved list
//! for `GET /api/v1/settings`, and one key's history.

use console_kernel_core::{KernelError, OrgId, Resolved, SettingVersionId, Timestamp};
use console_platform_db::settings_read::{SettingLayerKind, SettingScope, resolve_loaded};
use console_settings_domain::{
    Direction, Governance, LooserWhen, OverrideRow, SettingKey, SettingKind, SettingValue,
};
use serde::Serialize;
use sqlx::{PgConnection, Row};
use std::collections::BTreeMap;
use uuid::Uuid;

pub use console_platform_db::settings_read::{ResolvedSettings, load_rows_in_tx, resolve_in_tx};

/// Whether the `approval.policy.<class>` key `key` routes the change through
/// its approval route (decisions #26), tenant-wide, at the database's `now()`
/// (the clock `effective_from` is stamped with). Fail closed: any value but
/// `none` (and an unresolved key) reads as `route`.
///
/// # Errors
/// As [`load_rows_in_tx`].
pub async fn approval_routes_in_tx(
    conn: &mut PgConnection,
    org: OrgId,
    key: SettingKey,
) -> Result<bool, KernelError> {
    let now: Timestamp = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *conn)
        .await
        .map_err(db_error)?;
    let resolved = resolve_in_tx(conn, org, &[key], None, now).await?;
    Ok(!matches!(
        resolved.get(&key),
        Some(Ok(Resolved {
            value: SettingValue::Code("none"),
            ..
        }))
    ))
}

/// Resolved entries and the requested scope used for authorization.
#[derive(Debug)]
pub struct EffectiveSettings {
    pub items: Vec<EffectiveSetting>,
    /// The requested scope chain, independent of any key's governance or list order.
    pub resource_entities: Vec<Uuid>,
}

/// One key as the settings screens and `reference/settings` read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EffectiveSetting {
    pub key: SettingKey,
    pub kind: SettingKind,
    /// `None` for a tenant fact (no code default).
    pub default: Option<SettingValue>,
    pub looser_when: LooserWhen,
    pub governance: Governance,
    pub legal_basis: Option<LegalBasis>,
    /// `None` for a tenant fact not declared yet.
    pub value: Option<SettingValue>,
    pub version: Option<SettingVersionId>,
    /// When the override in force took effect; `None` for the code default.
    #[serde(with = "time::serde::rfc3339::option")]
    pub effective_from: Option<Timestamp>,
    /// Rows that take effect later (a loosening waiting out its delay).
    pub scheduled: Vec<ScheduledValue>,
    pub source: SettingSource,
    pub chain: Vec<SettingLayer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingSource {
    pub layer: SettingLayerKind,
    pub scope_entity_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingLayer {
    #[serde(flatten)]
    pub source: SettingSource,
    pub value: Option<SettingValue>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub effective_from: Option<Timestamp>,
    pub deciding: bool,
}

/// The citation behind a legal bound or fixed value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LegalBasis {
    pub authority: &'static str,
    pub title: &'static str,
    pub url: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScheduledValue {
    pub id: Uuid,
    pub scope_entity_id: Option<Uuid>,
    pub value: SettingValue,
    #[serde(with = "time::serde::rfc3339")]
    pub effective_from: Timestamp,
}

/// Every key, resolved at `now`.
pub(crate) fn effective_settings(
    rows: &BTreeMap<SettingKey, Vec<OverrideRow>>,
    chain: &[SettingScope],
    now: Timestamp,
) -> Vec<EffectiveSetting> {
    SettingKey::ALL
        .iter()
        .map(|&key| {
            let rows = rows.get(&key).map_or(&[][..], Vec::as_slice);
            let resolved = resolve_loaded(key, rows, chain, now).ok();
            let effective_from = match resolved.map(|r| r.version) {
                Some(SettingVersionId::Override(id)) => {
                    rows.iter().find(|r| r.id == id).map(|r| r.effective_from)
                }
                _ => None,
            };
            let def = key.def();
            let scopes: Vec<_> = if def.governance == Governance::PlatformOnly {
                vec![(SettingLayerKind::Platform, None)]
            } else {
                chain
                    .iter()
                    .map(|scope| (scope.layer, Some(scope.id)))
                    .chain([(SettingLayerKind::Tenant, None)])
                    .collect()
            };
            let layers: Vec<_> = scopes
                .into_iter()
                .chain([(SettingLayerKind::CodeDefault, None)])
                .map(|(layer, scope)| {
                    let row = rows
                        .iter()
                        .filter(|r| r.scope_entity_id == scope && r.effective_from <= now)
                        .max_by_key(|r| r.effective_from);
                    let deciding = resolved.is_some_and(|r| match r.version {
                        SettingVersionId::CodeDefault => layer == SettingLayerKind::CodeDefault,
                        SettingVersionId::Override(id) => {
                            layer != SettingLayerKind::CodeDefault
                                && row.is_some_and(|r| r.id == id)
                        }
                    });
                    SettingLayer {
                        source: SettingSource {
                            layer,
                            scope_entity_id: scope,
                        },
                        value: if layer == SettingLayerKind::CodeDefault {
                            def.default
                        } else {
                            row.map(|r| r.value)
                        },
                        effective_from: if layer == SettingLayerKind::CodeDefault {
                            None
                        } else {
                            row.map(|r| r.effective_from)
                        },
                        deciding,
                    }
                })
                .collect();
            let source = layers.iter().find(|l| l.deciding).map_or(
                SettingSource {
                    layer: SettingLayerKind::CodeDefault,
                    scope_entity_id: None,
                },
                |l| l.source.clone(),
            );
            EffectiveSetting {
                source,
                chain: layers,
                key,
                kind: def.kind,
                default: def.default,
                looser_when: def.looser_when,
                governance: def.governance,
                legal_basis: def.legal_basis.map(|s| LegalBasis {
                    authority: s.authority,
                    title: s.title,
                    url: s.url,
                }),
                value: resolved.map(|r| r.value),
                version: resolved.map(|r| r.version),
                effective_from,
                scheduled: rows
                    .iter()
                    .filter(|r| r.effective_from > now)
                    .map(|r| ScheduledValue {
                        id: r.id,
                        scope_entity_id: r.scope_entity_id,
                        value: r.value,
                        effective_from: r.effective_from,
                    })
                    .collect(),
            }
        })
        .collect()
}

/// One stored override row, newest first in a history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OverrideRecord {
    pub actor_kind: Option<String>,
    pub command_id: Option<Uuid>,
    pub id: Uuid,
    pub scope_entity_id: Option<Uuid>,
    pub value: serde_json::Value,
    #[serde(with = "time::serde::rfc3339")]
    pub effective_from: Timestamp,
    pub direction: Direction,
    pub onboarding_exempt: bool,
    pub set_by: Uuid,
    pub reason_code: String,
    pub reason_note: Option<String>,
    pub step_up_assertion_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

pub(crate) async fn history_in_tx(
    conn: &mut PgConnection,
    org: OrgId,
    key: SettingKey,
) -> Result<Vec<OverrideRecord>, KernelError> {
    let rows = sqlx::query(
        "SELECT id, scope_entity_id, value, effective_from, direction, onboarding_exempt,
                set_by, reason_code, reason_note, step_up_assertion_id, created_at,
                (SELECT e.actor_kind FROM audit_events e WHERE e.org_id=o.org_id AND e.actor=o.set_by AND e.created_at=o.created_at AND e.outcome='ALLOWED' ORDER BY e.id DESC LIMIT 1) AS actor_kind,
                (SELECT e.command_id FROM audit_events e WHERE e.org_id=o.org_id AND e.actor=o.set_by AND e.created_at=o.created_at AND e.outcome='ALLOWED' ORDER BY e.id DESC LIMIT 1) AS command_id
           FROM tenant_setting_overrides o
          WHERE org_id = $1 AND key = $2
          ORDER BY effective_from DESC, created_at DESC",
    )
    .bind(org.as_uuid())
    .bind(key.as_str())
    .fetch_all(conn)
    .await
    .map_err(db_error)?;
    rows.into_iter()
        .map(|row| {
            let direction: String = row.try_get("direction")?;
            Ok(OverrideRecord {
                actor_kind: row.try_get("actor_kind")?,
                command_id: row.try_get("command_id")?,
                id: row.try_get("id")?,
                scope_entity_id: row.try_get("scope_entity_id")?,
                value: row.try_get("value")?,
                effective_from: row.try_get("effective_from")?,
                direction: parse_direction(&direction),
                onboarding_exempt: row.try_get("onboarding_exempt")?,
                set_by: row.try_get("set_by")?,
                reason_code: row.try_get("reason_code")?,
                reason_note: row.try_get("reason_note")?,
                step_up_assertion_id: row.try_get("step_up_assertion_id")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(db_error)
}

/// The column's CHECK admits only these three.
pub(crate) fn parse_direction(raw: &str) -> Direction {
    match raw {
        "tighten" => Direction::Tighten,
        "loosen" => Direction::Loosen,
        _ => Direction::Neutral,
    }
}

pub(crate) use console_platform_db::settings_read::db_error;
