// SPDX-License-Identifier: LicenseRef-Proprietary
//! A bounded set of reads builds the inverse and its dependency proof.

use super::{Loaded, RollbackPreview, coded};
use crate::{HrError, import::caps::settings_in_tx};
use console_hr_domain::import::rollback::{self, Blocker, BlockerKind, InverseField, InverseRow};
use console_kernel_core::tenant_phase::admit_write;
use console_kernel_core::{TenantPhase, WriteClass};
use console_platform_authz::Principal;
use console_settings_domain::SettingKey;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub(super) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    run: Uuid,
    deciding: Option<(Uuid, OffsetDateTime)>,
    lock: bool,
) -> Result<Loaded, HrError> {
    let org = *principal.org_id.as_uuid();
    let query = "SELECT r.status, r.rollback_ledger_complete, r.applied_at, r.dry_run_summary, r.apply_job->>'state' AS job_state, \
        ARRAY(SELECT employee_id FROM import_run_row_snapshots WHERE org_id=$1 AND run_id=$2 \
          UNION SELECT employee_id FROM import_run_effects WHERE org_id=$1 AND run_id=$2) AS expected_people, \
        EXISTS(SELECT 1 FROM change_requests c WHERE c.org_id=r.org_id AND c.subject_id=r.id \
            AND c.kind='IMPORT_ROLLBACK' AND c.status='OPEN' AND ($3::UUID IS NULL OR c.id<>$3)) AS pending \
        FROM data_import_runs r WHERE r.org_id=$1 AND r.id=$2 AND r.entity_type='employee_hr'";
    let sql = if lock {
        format!("{query} FOR UPDATE OF r")
    } else {
        query.to_owned()
    };
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(org)
        .bind(run)
        .bind(deciding.map(|d| d.0))
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| coded("import_run_not_found"))?;
    let status: String = row.try_get("status")?;
    rollback::check_run(
        &status,
        row.try_get("rollback_ledger_complete")?,
        row.try_get("pending")?,
    )
    .map_err(coded)?;
    if row
        .try_get::<Option<String>, _>("job_state")?
        .is_some_and(|s| s != "done")
    {
        return Err(coded("import_run_not_applied"));
    }
    let phase: Option<String> =
        sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id=$1 FOR SHARE")
            .bind(org)
            .fetch_optional(tx.as_mut())
            .await?;
    let phase = TenantPhase::from_db(phase.as_deref());
    let setup = phase == TenantPhase::Setup;
    admit_write(
        phase,
        if setup {
            WriteClass::SetupVoid
        } else {
            WriteClass::Operational
        },
    )
    .map_err(crate::lifecycle::title_reason::coded)?;
    let keys = [
        SettingKey::ImportRollbackWindowDays,
        SettingKey::ApprovalPolicyImportRollback,
    ];
    let settings = settings_in_tx(tx, org, &keys).await?;
    let days = settings
        .get(&keys[0])
        .and_then(|v| v.as_int())
        .ok_or_else(|| HrError::internal("rollback window"))?;
    let routed = matches!(
        settings.get(&keys[1]),
        Some(console_settings_domain::SettingValue::Code("route"))
    );
    let applied: OffsetDateTime = row
        .try_get::<Option<OffsetDateTime>, _>("applied_at")?
        .ok_or_else(|| coded("import_run_not_applied"))?;
    let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(tx.as_mut())
        .await?;
    let basis = rollback::basis(setup, applied, deciding.map_or(now, |d| d.1), days, routed)
        .map_err(coded)?;
    let plan: Value = row.try_get("dry_run_summary")?;
    // The same ordered locks as correction/void serialize the re-check with later personnel writes.
    let head_sql = "/* import_rollback:heads */ SELECT e.id, e.employee_number, to_jsonb(e) AS head, \
        e.name,e.hire_date,e.exit_date,e.job,e.position,e.worksite_name,e.worksite_address, \
        to_char(e.birth_date,'YYYY-MM-DD') AS birth_date,e.work_email,e.id_type, \
        e.grade_id::text,e.job_title_id::text,e.position_kind_id::text,e.job_id::text,e.job_family_id::text, \
        e.employment_status,e.updated_at,e.identity_review_required, \
        p.employee_id IS NOT NULL AS has_profile,p.phone_e164,p.employment_type,p.base_pay::text AS base_pay,p.pay_unit, \
        to_char(p.probation_end_date,'YYYY-MM-DD') AS probation_end_date,p.probation_confirmed_at IS NOT NULL AS probation_confirmed, \
        to_jsonb(p) AS profile, s.outcome, s.before, s.source_key, \
        (SELECT b.name FROM import_run_effects f JOIN branches b ON b.org_id=f.org_id AND b.id=e.home_branch_id \
          WHERE f.org_id=e.org_id AND f.run_id=$2 AND f.employee_id=e.id AND f.effect='home_branch_set') AS imported_branch, \
        COALESCE((SELECT jsonb_agg(f.effect ORDER BY f.effect) FROM import_run_effects f \
            WHERE f.org_id=e.org_id AND f.run_id=$2 AND f.employee_id=e.id AND f.effect<>'head_settled'),'[]') AS effects \
        FROM employees e LEFT JOIN employee_employment_profiles p ON p.org_id=e.org_id AND p.employee_id=e.id \
        LEFT JOIN import_run_row_snapshots s ON s.org_id=e.org_id AND s.run_id=$2 AND s.employee_id=e.id \
        WHERE e.org_id=$1 AND (s.employee_id IS NOT NULL OR EXISTS(SELECT 1 FROM import_run_effects f \
            WHERE f.org_id=e.org_id AND f.run_id=$2 AND f.employee_id=e.id)) ORDER BY e.id";
    let head_sql = if lock {
        format!("{head_sql} FOR UPDATE OF e")
    } else {
        head_sql.to_owned()
    };
    let heads = sqlx::query(sqlx::AssertSqlSafe(head_sql))
        .bind(org)
        .bind(run)
        .fetch_all(tx.as_mut())
        .await?;
    let planned: std::collections::BTreeMap<_, _> = plan["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["source_key"].as_str().map(|key| (key, r)))
        .collect();
    let mut locked_heads = std::collections::BTreeMap::new();
    let mut inverse = Vec::with_capacity(heads.len());
    let mut blockers = Vec::new();
    for head in &heads {
        let id: Uuid = head.try_get("id")?;
        let number: Option<String> = head.try_get("employee_number")?;
        let inserted = head.try_get::<Option<String>, _>("outcome")?.as_deref() == Some("INSERTED");
        let source: Option<String> = head.try_get("source_key")?;
        let before: Option<Value> = head.try_get("before")?;
        let live: Value = head.try_get("head")?;
        let profile: Option<Value> = head.try_get("profile")?;
        let mut fields = Vec::new();
        if !inserted {
            let planned = source.as_deref().and_then(|key| planned.get(key).copied());
            for change in planned
                .into_iter()
                .flat_map(|r| r["diff"].as_array().into_iter().flatten())
            {
                let Some(field) = change["field"].as_str() else {
                    continue;
                };
                let current = if field == "employment_type" {
                    profile.as_ref().and_then(|p| p[field].as_str())
                } else {
                    live[field].as_str()
                };
                let expected = change["to"].as_str();
                if current != expected {
                    blockers.push(Blocker {
                        employee_id: id,
                        employee_number: number.clone(),
                        kind: BlockerKind::ChangedSince,
                        field: Some(field.into()),
                        record: format!("/people/{id}"),
                        since: live["updated_at"].as_str().unwrap_or_default().into(),
                    });
                }
                // A profile did not exist before its creation; scalar before-images stay in the snapshot.
                let old = before.as_ref().and_then(|v| v[field].as_str());
                fields.push(InverseField {
                    field: field.into(),
                    current: current.map(str::to_owned),
                    before: old.map(str::to_owned),
                });
            }
        }
        if lock && !inserted && !fields.is_empty() {
            locked_heads.insert(
                id,
                crate::corrections::LockedEmployee::for_import_rollback(
                    head,
                    &fields.iter().map(|f| f.field.clone()).collect::<Vec<_>>(),
                )?,
            );
        }
        if let Some(branch) = head.try_get::<Option<String>, _>("imported_branch")? {
            fields.push(InverseField {
                field: "home_branch_id".into(),
                current: Some(branch),
                before: None,
            });
        }
        let effects: Value = head.try_get("effects")?;
        inverse.push(InverseRow {
            employee_id: id,
            employee_number: number,
            inserted,
            fields,
            effects: effects
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        });
    }
    // No check query per person: all work records, later runs and accounts are read as one set.
    let dependencies=sqlx::query("/* import_rollback:blockers */ WITH people AS ( \
        SELECT e.id, e.employee_number, e.updated_at, s.outcome='INSERTED' AS inserted, \
          (SELECT max(f.created_at) FROM import_run_effects f WHERE f.org_id=e.org_id AND f.run_id=$2 AND f.employee_id=e.id) AS settled \
        FROM employees e LEFT JOIN import_run_row_snapshots s ON s.org_id=e.org_id AND s.run_id=$2 AND s.employee_id=e.id \
        WHERE e.org_id=$1 AND (s.employee_id IS NOT NULL OR EXISTS(SELECT 1 FROM import_run_effects f WHERE f.org_id=$1 AND f.run_id=$2 AND f.employee_id=e.id)) \
        ) SELECT p.id, p.employee_number, p.updated_at, p.settled, p.inserted, \
        EXISTS(SELECT 1 FROM employee_exit_cases c WHERE c.org_id=$1 AND c.employee_id=p.id) OR \
        EXISTS(SELECT 1 FROM employee_lifecycle_events l WHERE l.org_id=$1 AND l.employee_id=p.id AND l.state='APPLIED' \
          AND NOT EXISTS(SELECT 1 FROM import_run_effects f WHERE f.org_id=$1 AND f.run_id=$2 AND f.target_id=l.id AND f.effect IN ('setup_leave','onboard_scheduled'))) OR \
        EXISTS(SELECT 1 FROM employee_attendance_records a WHERE a.org_id=$1 AND a.employee_id=p.id) OR \
        EXISTS(SELECT 1 FROM payroll_draft_lines a WHERE a.org_id=$1 AND a.employee_id=p.id) AS work_record, \
        EXISTS(SELECT 1 FROM users u WHERE u.org_id=$1 AND u.employee_id=p.id) AS account_linked, \
        EXISTS(SELECT 1 FROM import_run_row_snapshots s JOIN data_import_runs r ON r.org_id=s.org_id AND r.id=s.run_id \
          WHERE s.org_id=$1 AND s.employee_id=p.id AND s.run_id<>$2 AND r.status='APPLIED' AND r.applied_at>$3) OR \
        EXISTS(SELECT 1 FROM import_run_effects f JOIN data_import_runs r ON r.org_id=f.org_id AND r.id=f.run_id \
          WHERE f.org_id=$1 AND f.employee_id=p.id AND f.run_id<>$2 AND r.status='APPLIED' AND r.applied_at>$3) AS later_run, \
        EXISTS(SELECT 1 FROM employee_corrections c WHERE c.org_id=$1 AND c.employee_id=p.id \
          AND c.import_run_id IS DISTINCT FROM $2 AND c.created_at>p.settled \
          AND NOT EXISTS(SELECT 1 FROM data_import_runs cr WHERE cr.org_id=c.org_id AND cr.id=c.import_run_id AND cr.status='ROLLED_BACK') AND (p.inserted OR EXISTS ( \
            SELECT 1 FROM data_import_runs ir CROSS JOIN LATERAL jsonb_array_elements(ir.dry_run_summary->'rows') pr(row) \
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pr.row->'diff','[]')) df(change) \
            WHERE ir.org_id=$1 AND ir.id=$2 AND pr.row->>'employee_id'=p.id::TEXT AND df.change->>'field'=c.field))) OR \
        EXISTS(SELECT 1 FROM import_run_effects f JOIN employees e ON e.org_id=f.org_id AND e.id=f.employee_id \
          WHERE f.org_id=$1 AND f.run_id=$2 AND f.employee_id=p.id AND f.effect='home_branch_set' AND e.home_branch_id IS DISTINCT FROM f.target_id) OR \
        EXISTS(SELECT 1 FROM import_run_effects f JOIN employee_employment_profiles ep ON ep.org_id=f.org_id AND ep.employee_id=f.target_id \
          WHERE f.org_id=$1 AND f.run_id=$2 AND f.employee_id=p.id AND f.effect='profile_created' AND f.target_digest IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(ep)::text,'UTF8')),'hex')) OR \
        EXISTS(SELECT 1 FROM import_run_effects f JOIN employee_register_facts rf ON rf.org_id=f.org_id AND rf.employee_id=f.target_id \
          WHERE f.org_id=$1 AND f.run_id=$2 AND f.employee_id=p.id AND f.effect='register_fact' AND rf.updated_at>p.settled) OR EXISTS(SELECT 1 FROM employee_identity_resolutions m WHERE m.org_id=$1 AND m.employee_id=p.id \
          AND m.merged_into_employee_id IS NOT NULL) AS changed_since, \
        EXISTS(SELECT 1 FROM employee_corrections c JOIN data_import_runs cr ON cr.org_id=c.org_id AND cr.id=c.import_run_id \
          WHERE c.org_id=$1 AND c.employee_id=p.id AND c.reason_code='IMPORT_ROLLBACK' AND cr.status='ROLLED_BACK' \
            AND c.created_at=p.updated_at) AS rollback_version \
        FROM people p")
        .bind(org).bind(run).bind(applied).fetch_all(tx.as_mut()).await?;
    for d in dependencies {
        let id: Uuid = d.try_get("id")?;
        let inserted = d.try_get::<Option<bool>, _>("inserted")?.unwrap_or(false);
        let updated: OffsetDateTime = d.try_get("updated_at")?;
        let settled: Option<OffsetDateTime> = d.try_get("settled")?;
        let facts = rollback::Dependencies {
            work_record_runs: if d.try_get("work_record")? {
                vec![None]
            } else {
                vec![]
            },
            changed_since: d.try_get::<bool, _>("changed_since")?
                || (inserted
                    && settled.is_none_or(|s| updated > s)
                    && !d.try_get::<bool, _>("rollback_version")?),
            later_run: d.try_get("later_run")?,
            account_linked: d.try_get("account_linked")?,
        };
        for kind in facts.kinds(run, inserted) {
            blockers.push(Blocker {
                employee_id: id,
                employee_number: d.try_get("employee_number")?,
                kind,
                field: None,
                record: format!("/people/{id}"),
                since: updated
                    .format(&Rfc3339)
                    .map_err(|_| HrError::internal("rollback dependency time"))?,
            });
        }
    }
    let visible: std::collections::BTreeSet<_> = inverse.iter().map(|r| r.employee_id).collect();
    for id in row.try_get::<Vec<Uuid>, _>("expected_people")? {
        if !visible.contains(&id) {
            blockers.push(Blocker {
                employee_id: id,
                employee_number: None,
                kind: BlockerKind::ChangedSince,
                field: None,
                record: format!("/people/{id}"),
                since: applied
                    .format(&Rfc3339)
                    .map_err(|_| HrError::internal("rollback time"))?,
            });
        }
    }
    let digest = rollback::preview_digest(&inverse, &blockers)
        .map_err(|_| HrError::internal("rollback digest"))?;
    Ok(Loaded {
        heads: locked_heads,
        routed,
        preview: RollbackPreview {
            run_id: run,
            mode: if setup { "SETUP" } else { "GOVERNED" },
            basis,
            window_until: (!setup).then_some(applied + Duration::days(days)),
            window_days: days,
            rows: inverse,
            allowed: if blockers.is_empty() {
                vec!["rollback"]
            } else {
                vec![]
            },
            blockers,
            preview_digest: digest,
        },
    })
}
