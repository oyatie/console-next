// SPDX-License-Identifier: LicenseRef-Proprietary
//! Scoped people-reach and worker-favorability impact calculation for settings previews.

use crate::read::{db_error, load_rows_in_tx};
use console_kernel_core::{KernelError, OrgId, Timestamp};
use console_platform_db::settings_read::resolve_loaded;
use console_settings_application::ScopeImpact;
use console_settings_domain::{ScopeCeiling, SettingKey, SettingValue, WorkerFavorable};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

pub(crate) async fn compute_scope_impact(
    conn: &mut PgConnection,
    org: OrgId,
    key: SettingKey,
    entity: Option<Uuid>,
    proposed: Option<SettingValue>,
    as_of: Timestamp,
) -> Result<ScopeImpact, KernelError> {
    let target_layer = if let Some(scope_id) = entity {
        let raw_layer: Option<String> = sqlx::query_scalar(
            "SELECT layer FROM setting_scope_chain($1, $2) ORDER BY seq LIMIT 1",
        )
        .bind(org.as_uuid())
        .bind(scope_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db_error)?;
        let Some(raw) = raw_layer else {
            return Err(KernelError::validation("unknown or inactive setting scope")
                .with_code("setting_scope_unknown")
                .with_field("scope_entity_id"));
        };
        match raw.as_str() {
            "legal_entity" => Some(ScopeCeiling::LegalEntity),
            "workplace" => Some(ScopeCeiling::Workplace),
            "department" => Some(ScopeCeiling::Department),
            "person" => Some(ScopeCeiling::Person),
            _ => Some(ScopeCeiling::Workplace),
        }
    } else {
        Some(ScopeCeiling::Tenant)
    };

    let active_employees: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM employees
          WHERE org_id = $1
            AND merged_into_employee_id IS NULL
            AND entity_employed_on(entity_today(), hire_on, exit_on, employment_status)",
    )
    .bind(org.as_uuid())
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;

    if active_employees.is_empty() {
        return Ok(ScopeImpact {
            target_layer,
            affected_people_count: 0,
            out_of_scope_people_count: 0,
            disfavored_people_count: 0,
        });
    }

    let def = key.def();
    let proposed_ord = proposed.and_then(|v| def.ordinal(v));
    let mut affected = 0_i64;
    let mut out_of_scope = 0_i64;
    let mut disfavored = 0_i64;

    for emp_id in active_employees {
        let (chain, rows_map) = load_rows_in_tx(&mut *conn, org, &[key], Some(emp_id)).await?;
        let in_scope = match entity {
            None => true,
            Some(scope_id) => chain.iter().any(|s| s.id == scope_id),
        };
        if !in_scope {
            out_of_scope += 1;
            continue;
        }
        let rows = rows_map.get(&key).map_or(&[][..], Vec::as_slice);
        let shielded = match entity {
            None => chain.iter().any(|s| {
                rows.iter()
                    .any(|r| r.scope_entity_id == Some(s.id) && r.effective_from <= as_of)
            }),
            Some(scope_id) => chain.iter().take_while(|s| s.id != scope_id).any(|s| {
                rows.iter()
                    .any(|r| r.scope_entity_id == Some(s.id) && r.effective_from <= as_of)
            }),
        };
        if shielded {
            out_of_scope += 1;
            continue;
        }
        affected += 1;
        if def.worker_favorable != WorkerFavorable::Neutral
            && let Some(next_ord) = proposed_ord
            && let Ok(current) = resolve_loaded(key, rows, &chain, as_of)
            && let Some(cur_ord) = def.ordinal(current.value)
        {
            let worse = match def.worker_favorable {
                WorkerFavorable::Higher => next_ord < cur_ord,
                WorkerFavorable::Lower => next_ord > cur_ord,
                WorkerFavorable::Neutral => false,
            };
            if worse {
                disfavored += 1;
            }
        }
    }

    Ok(ScopeImpact {
        target_layer,
        affected_people_count: affected,
        out_of_scope_people_count: out_of_scope,
        disfavored_people_count: disfavored,
    })
}

pub(crate) async fn descendant_overrides(
    conn: &mut PgConnection,
    org: OrgId,
    key: SettingKey,
    entity: Option<Uuid>,
    as_of: Timestamp,
) -> Result<Vec<Uuid>, KernelError> {
    let rows = sqlx::query(
        "SELECT DISTINCT scope_entity_id
           FROM tenant_setting_overrides
          WHERE org_id = $1 AND key = $2 AND effective_from <= $3
            AND scope_entity_id IS NOT NULL
          ORDER BY scope_entity_id",
    )
    .bind(org.as_uuid())
    .bind(key.as_str())
    .bind(as_of)
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;

    let mut out = Vec::new();
    for row in rows {
        let candidate: Uuid = row.try_get("scope_entity_id").map_err(db_error)?;
        if Some(candidate) == entity {
            continue;
        }
        let Some(parent) = entity else {
            out.push(candidate);
            continue;
        };
        let under: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM setting_scope_chain($1, $2) WHERE scope_id = $3)",
        )
        .bind(org.as_uuid())
        .bind(candidate)
        .bind(parent)
        .fetch_one(&mut *conn)
        .await
        .map_err(db_error)?;
        if under {
            out.push(candidate);
        }
    }
    Ok(out)
}
