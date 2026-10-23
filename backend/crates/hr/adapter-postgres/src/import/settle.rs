//! After the leave command applied a run: every person the run inserted gets
//! what a registration gives them. A current employee opens the canonical
//! employment (through the Employment owner; without it an org change refuses
//! them as unbound). An 입사 예정 (PRE_HIRE) one gets the SCHEDULED ONBOARD the
//! lifecycle runner applies on the first day. A former employee (이관) gets
//! nothing: their history starts and ends before the product. Then the
//! profile, placement and correction-ledger rows of the run (MR-7,
//! `settle_facts`).

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_ontology_canonical_adapter_postgres::employment;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;
use crate::clock::today_kst;
use crate::directory::create_onboard::{RegistrationOnboard, record_registration_onboard};
use crate::import::apply_job::{ApplyJob, progress_audit, write_job};
use crate::import::apply_report::register_gaps_in;
use crate::import::settle_facts::{record_import_facts, recorded_json};
use crate::import::settle_setup::record_setup_facts;

type Inserted = (
    Uuid,
    String,
    String,
    Option<String>,
    Option<Uuid>,
    Option<String>,
    Option<String>,
    bool,
);

/// Rows one settle transaction covers (W11, #28 bounded work per transaction).
/// a constant; a settings key if operators ever need to tune it.
pub const SETTLE_CHUNK_ROWS: usize = 100;

/// One settle transaction: the plan rows it covers, whether it is the run's
/// last, and the job to store with it (its progress, audited).
pub struct Chunk<'a> {
    pub keys: &'a [String],
    pub last: bool,
    pub job: Option<ApplyJob>,
}

/// The plan rows of an applied run in plan order: the settle's unit of work
/// and of progress.
pub async fn settle_keys(pool: &PgPool, org: OrgId, run_id: Uuid) -> Result<Vec<String>, HrError> {
    let org_uuid = *org.as_uuid();
    with_org_conn::<_, _, HrError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query_scalar(
                "SELECT plan.row->>'source_key' FROM data_import_runs r \
                 CROSS JOIN LATERAL jsonb_array_elements(r.dry_run_summary->'rows') \
                   WITH ORDINALITY plan(row, n) \
                 WHERE r.org_id = $1 AND r.id = $2 ORDER BY plan.n",
            )
            .bind(org_uuid)
            .bind(run_id)
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await
}

/// Settles the rows of `chunk` in one audited transaction (each write skipped
/// when already there); returns how many of its new people were bound.
pub async fn settle_chunk(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    run_id: Uuid,
    chunk: Chunk<'_>,
) -> Result<usize, HrError> {
    let org_uuid = *org.as_uuid();
    let Chunk { keys, last, job } = chunk;
    let keys = keys.to_vec();
    with_audits::<_, _, HrError>(pool, org, move |tx| {
        Box::pin(async move {
            // Serializes a concurrent second apply of the run (the leave
            // command replays it), which then finds everything settled.
            sqlx::query("SELECT 1 FROM data_import_runs WHERE org_id = $1 AND id = $2 FOR UPDATE")
                .bind(org_uuid)
                .bind(run_id)
                .execute(tx.as_mut())
                .await?;
            let people: Vec<Inserted> = sqlx::query_as(
                "SELECT e.id, e.employment_status, e.company, e.org_unit, e.org_unit_id, \
                        e.position, e.hire_date::TEXT, \
                        EXISTS (SELECT 1 FROM employee_lifecycle_events l \
                                WHERE l.org_id = e.org_id AND l.employee_id = e.id \
                                  AND l.event_type = 'ONBOARD') \
                 FROM import_run_row_snapshots s \
                 JOIN employees e ON e.org_id = s.org_id AND e.id = s.employee_id \
                 WHERE s.org_id = $1 AND s.run_id = $2 AND s.outcome = 'INSERTED' \
                   AND s.source_key = ANY($3) \
                 ORDER BY e.created_at, e.id",
            )
            .bind(org_uuid)
            .bind(run_id)
            .bind(&keys)
            .fetch_all(tx.as_mut())
            .await?;
            let (mut appointed, mut scheduled, mut unappointed) = (0, 0, Vec::new());
            for (id, status, company, unit, unit_id, position, hire, onboarded) in &people {
                match status.as_str() {
                    "PRE_HIRE" if *onboarded => {}
                    "PRE_HIRE" => {
                        record_registration_onboard(
                            tx,
                            org_uuid,
                            *actor.as_uuid(),
                            *id,
                            &RegistrationOnboard {
                                company,
                                org_unit: unit.as_deref().unwrap_or_default(),
                                org_unit_id: *unit_id,
                                position: position.as_deref().unwrap_or_default(),
                                hire_date: hire.as_deref(),
                            },
                            today_kst(),
                        )
                        .await?;
                        let event: Uuid = sqlx::query_scalar(
                            "SELECT id FROM employee_lifecycle_events \
                             WHERE org_id = $1 AND employee_id = $2 \
                               AND event_type = 'ONBOARD'",
                        )
                        .bind(org_uuid)
                        .bind(id)
                        .fetch_one(tx.as_mut())
                        .await?;
                        crate::import::effects::record(
                            tx,
                            org_uuid,
                            run_id,
                            *id,
                            "onboard_scheduled",
                            event,
                        )
                        .await?;
                        scheduled += 1;
                    }
                    "EXITED" => {}
                    _ => match employment::appoint_legacy_head_in_tx(tx, org, actor, *id).await {
                        Ok(Some(receipt)) => {
                            let employment: Uuid =
                                serde_json::from_value(receipt.result()["employment_id"].clone())
                                    .map_err(|_| {
                                    HrError::internal("appointment receipt has no employment id")
                                })?;
                            crate::import::effects::record(
                                tx,
                                org_uuid,
                                run_id,
                                *id,
                                "employment_opened",
                                employment,
                            )
                            .await?;
                            appointed += 1;
                        }
                        Ok(None) => {}
                        // The owner refused before writing anything (blank
                        // company, hire date in a closed period, unknown
                        // unit/position reference): the person stays
                        // unappointed and the audit row names them.
                        Err(
                            employment::EmploymentError::Blocked(_)
                            | employment::EmploymentError::Frozen(_)
                            | employment::EmploymentError::UnknownOrgUnit(_)
                            | employment::EmploymentError::UnknownJobPosition(_),
                        ) => unappointed.push(*id),
                        Err(error) => return Err(error.into()),
                    },
                }
            }
            let recorded =
                record_import_facts(tx, org_uuid, *actor.as_uuid(), run_id, &keys).await?;
            let setup =
                record_setup_facts(tx, org_uuid, *actor.as_uuid(), run_id, (&keys, last)).await?;
            crate::import::effects::assign_home_branches(
                tx,
                org_uuid,
                *actor.as_uuid(),
                run_id,
                &keys,
            )
            .await?;
            crate::import::effects::capture_heads(tx, org_uuid, run_id, &keys).await?;
            if last {
                sqlx::query(
                    "UPDATE data_import_runs SET rollback_ledger_complete = true \
                     WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(run_id)
                .execute(tx.as_mut())
                .await?;
            }
            let bound = people.iter().filter(|p| p.4.is_some()).count();
            let audit = AuditEvent::new(
                Some(actor),
                AuditAction::new("employee.import.settle").map_err(HrError::from_kernel)?,
                "data_import_run",
                run_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_source(console_kernel_core::AuditSource::Import)
            .with_org(org)
            .with_snapshots(
                None,
                Some(json!({
                    "inserted": people.len(),
                    "appointed": appointed,
                    "onboard_scheduled": scheduled,
                    "unappointed": unappointed,
                    "org_unit_bound": bound,
                    "recorded": recorded_json(&recorded),
                    "setup_leaves": setup.leaves,
                    "identities_recorded": setup.identities,
                })),
            );
            // The last chunk always says so: its event is the one that tells
            // the screen the job is done (r3:hire-02).
            let wrote = appointed + scheduled + unappointed.len() + setup.leaves + setup.identities
                > 0
                || recorded.any()
                || last;
            let mut audits = if wrote { vec![audit] } else { Vec::new() };
            // r3:hire-16: the done job's report says what the 명부 still lacks,
            // read after this last chunk's writes.
            let mut job = job;
            if let Some(report) = job
                .as_mut()
                .and_then(|j| j.report.as_mut())
                .filter(|_| last)
            {
                report.register_gaps = Some(register_gaps_in(tx, org_uuid, run_id).await?);
            }
            if let Some(job) = &job {
                write_job(tx, org_uuid, job).await?;
                audits.push(progress_audit(org, job)?);
            }
            Ok((bound, audits))
        })
    })
    .await
}
