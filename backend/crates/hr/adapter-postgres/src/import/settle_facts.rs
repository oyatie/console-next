//! MR-7: what an applied run records beyond the employee rows the leave
//! command wrote, from the plan the operator saw (the stored dry run, which
//! the apply re-planned and digest-checked):
//!
//! - every person the run inserted gets the employment profile when the file
//!   gave a 고용형태, and a current one is placed at their 사업장 (the first
//!   법인 · 사업장 assignment, through the entity owner) unless 미배치;
//! - every change the run made to a person on file is a row of the BW-18
//!   correction ledger naming the run, and a 고용형태 the person had none of
//!   creates their profile.
//!
//! Each write is skipped when already there, so a replayed settle (a second
//! apply, or one after a failure here) completes the run without doubling.

use console_entity_adapter_postgres::employment_hire::hire_in_tx;
use console_entity_adapter_postgres::employment_moves::MoveWrite;
use console_hr_domain::text::parse_yyyy_mm_dd;
use serde_json::{Value, json};
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::digest::sha256_hex;
use crate::lifecycle::title_reason::coded;

/// The ledger reason of a change an import applied.
const IMPORT_REASON: &str = "IMPORT_APPLY";

/// What the settle wrote, for the run's audit row.
#[derive(Debug, Default)]
pub struct Recorded {
    pub profiles: usize,
    pub placed: usize,
    pub ledgered: usize,
}

impl Recorded {
    pub fn any(&self) -> bool {
        self.profiles + self.placed + self.ledgered > 0
    }
}

/// The profile from the 고용형태, the file's 휴대전화 (W12; pay unknown) and
/// its 계약종료일 · 수습종료일 (r3:hire-16); `true` when it was created now.
async fn profile(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    (org, actor, employee): (Uuid, Uuid, Uuid),
    kind: &str,
    (phone, person): (Option<&str>, &Value),
    key: &str,
) -> Result<bool, HrError> {
    let done = sqlx::query(
        "INSERT INTO employee_employment_profiles \
           (employee_id, org_id, employment_type, idempotency_key, request_hash, created_by, \
            phone_e164, contract_end_date, probation_end_date) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::DATE, $9::DATE) \
         ON CONFLICT (employee_id) DO NOTHING",
    )
    .bind(employee)
    .bind(org)
    .bind(kind)
    .bind(key)
    .bind(sha256_hex(key.as_bytes()))
    .bind(actor)
    .bind(phone)
    .bind(person["contract_end_date"].as_str())
    .bind(person["probation_end_date"].as_str())
    .execute(tx.as_mut())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// r3:hire-16: a new person's 성별 as the first 근로자 명부 record, with its
/// ledger row naming the run (once: a replayed settle writes nothing new).
async fn first_sex(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    (org, actor, run, employee): (Uuid, Uuid, Uuid, Uuid),
    person: &Value,
) -> Result<bool, HrError> {
    let Some(sex) = person["sex"].as_str() else {
        return Ok(false);
    };
    let created: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO employee_register_facts (org_id, employee_id) VALUES ($1, $2) \
         ON CONFLICT (org_id, employee_id) DO NOTHING RETURNING employee_id",
    )
    .bind(org)
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await?;
    if created.is_none() {
        return Ok(false);
    }
    crate::register_facts::store::write_in_tx(
        tx,
        org,
        employee,
        &[("sex", Some(sex))],
        actor,
        None,
    )
    .await?;
    if created.is_some() {
        super::effects::record(tx, org, run, employee, "register_fact", employee).await?;
    }
    ledger(
        tx,
        org,
        actor,
        run,
        employee,
        &json!({ "field": "sex", "from": null, "to": sex }),
    )
    .await
}

/// One ledger row per changed field, once per run.
async fn ledger(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    run: Uuid,
    employee: Uuid,
    change: &Value,
) -> Result<bool, HrError> {
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO employee_corrections (org_id, employee_id, field, old_value, new_value, \
           reason_code, corrected_by, import_run_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (org_id, import_run_id, employee_id, field, reason_code) \
         WHERE import_run_id IS NOT NULL DO NOTHING RETURNING id",
    )
    .bind(org)
    .bind(employee)
    .bind(change["field"].as_str())
    .bind(Some(&change["from"]).filter(|from| !from.is_null()))
    .bind(&change["to"])
    .bind(IMPORT_REASON)
    .bind(actor)
    .bind(run)
    .fetch_optional(tx.as_mut())
    .await?;
    if let Some(id) = inserted {
        super::effects::record(tx, org, run, employee, "ledger", id).await?;
    }
    Ok(inserted.is_some())
}

/// The first assignment of a current person the plan placed, unless they
/// have one already.
async fn place(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    employee: Uuid,
    person: &Value,
) -> Result<Option<Uuid>, HrError> {
    let Some(workplace) = person["workplace_id"].as_str() else {
        return Ok(None);
    };
    let placed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM employment_assignments \
         WHERE org_id = $1 AND employee_id = $2 AND superseded_at IS NULL)",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await?;
    if placed || person["status"] == "EXITED" {
        return Ok(None);
    }
    let workplace = Uuid::parse_str(workplace)
        .map_err(|_| HrError::internal("stored import plan has a malformed workplace id"))?;
    let hire = parse_yyyy_mm_dd(person["hire_date"].as_str().unwrap_or_default())?;
    let command_id = Uuid::new_v4();
    let write = MoveWrite {
        org_id: org,
        employee_id: employee,
        actor_id: actor,
        command_id,
    };
    let opened: Option<time::Date> = sqlx::query_scalar("SELECT entity_workplace_opens_on($1)")
        .bind(workplace)
        .fetch_one(tx.as_mut())
        .await?;
    let from = opened.map_or(hire, |opened| hire.max(opened));
    match hire_in_tx(tx.as_mut(), write, workplace, from).await {
        Ok(_) => Ok(Some(
            sqlx::query_scalar(
                "SELECT id FROM employment_assignments \
                 WHERE org_id = $1 AND employee_id = $2 AND command_id = $3",
            )
            .bind(org)
            .bind(employee)
            .bind(command_id)
            .fetch_one(tx.as_mut())
            .await?,
        )),
        // Closed after the apply re-planned (which re-checks it): the person
        // stays 미배치 rather than a settle that can never finish.
        Err(error) if error.code == Some("workplace_not_open") => Ok(None),
        Err(error) => Err(coded(error)),
    }
}

/// Records the profile, placement and ledger rows of the rows `keys` of an
/// applied run (W11: one settle chunk).
pub async fn record_import_facts(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    run: Uuid,
    keys: &[String],
) -> Result<Recorded, HrError> {
    let rows: Vec<(String, Uuid, String, Value)> = sqlx::query_as(
        "SELECT s.source_key, s.employee_id, s.outcome, plan.row FROM import_run_row_snapshots s \
         JOIN data_import_runs r ON r.org_id = s.org_id AND r.id = s.run_id \
         CROSS JOIN LATERAL jsonb_array_elements(r.dry_run_summary->'rows') plan(row) \
         WHERE s.org_id = $1 AND s.run_id = $2 AND plan.row->>'source_key' = s.source_key \
           AND s.source_key = ANY($3) \
         ORDER BY s.source_key",
    )
    .bind(org)
    .bind(run)
    .bind(keys)
    .fetch_all(tx.as_mut())
    .await?;
    // W12: the staged 휴대전화 of these rows, taken (deleted) as they are stored.
    let phones = crate::import::phones::take(tx, org, run, keys).await?;
    let mut recorded = Recorded::default();
    for (source_key, employee, outcome, row) in &rows {
        let phone = phones.get(source_key).map(String::as_str);
        let who = (org, actor, *employee);
        let key = format!("import:{run}:{source_key}");
        if outcome == "INSERTED" {
            let person = &row["new_person"];
            if let Some(kind) = person["employment_type"].as_str()
                && profile(tx, who, kind, (phone, person), &key).await?
            {
                super::effects::record(tx, org, run, *employee, "profile_created", *employee)
                    .await?;
                recorded.profiles += 1;
            }
            if first_sex(tx, (org, actor, run, *employee), person).await? {
                recorded.ledgered += 1;
            }
            if let Some(assignment) = place(tx, org, actor, *employee, person).await? {
                super::effects::record(tx, org, run, *employee, "placed", assignment).await?;
                recorded.placed += 1;
            }
            continue;
        }
        for change in row["diff"].as_array().into_iter().flatten() {
            if change["field"] == "employment_type"
                && let Some(kind) = change["to"].as_str()
                && profile(tx, who, kind, (None, &Value::Null), &key).await?
            {
                super::effects::record(tx, org, run, *employee, "profile_created", *employee)
                    .await?;
                recorded.profiles += 1;
            }
            if ledger(tx, org, actor, run, *employee, change).await? {
                recorded.ledgered += 1;
            }
        }
    }
    Ok(recorded)
}

/// The audit snapshot of [`Recorded`].
pub fn recorded_json(recorded: &Recorded) -> Value {
    json!({
        "profiles_created": recorded.profiles,
        "placed": recorded.placed,
        "corrections_recorded": recorded.ledgered,
    })
}
