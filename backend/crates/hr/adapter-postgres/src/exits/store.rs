//! Exit-case context, branch resolution and the exit lifecycle event writers
//! (moved from `app/src/hr.rs`, R2-exits).

use console_hr_domain::exits::case::ExitCaseContext;
use console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition;
use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use console_hr_domain::text::normalize_enum_text;
use console_kernel_core::{KernelError, OrgId, UserId};
use console_ontology_canonical_adapter_postgres::employment;
use sqlx::{Postgres, QueryBuilder, Row};
use uuid::Uuid;

use crate::HrError;
use crate::clock::today_kst;
use crate::exits::assignment_end::{end_assignment, reopen_assignment};
use crate::lifecycle::prepare::prepare_lifecycle_event;
use crate::lifecycle::record::{cancel_scheduled_lifecycle_event_tx, record_lifecycle_event_tx};
use crate::lifecycle::rules::lifecycle_refusal;
use crate::lifecycle::store::load_employee_for_lifecycle;

pub async fn load_exit_case_context(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    case_id: Uuid,
    lock_case: bool,
) -> Result<ExitCaseContext, HrError> {
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            c.id,
            c.employee_id,
            e.name AS employee_name,
            e.employee_number,
            e.company,
            e.org_unit,
            e.position,
            e.worksite_name,
            to_char(e.hire_on, 'YYYY-MM-DD') AS hire_date,
            c.branch_id,
            b.name AS branch_name,
            c.status,
            c.hr_confirmed_by,
            c.effective_exit_date::TEXT AS effective_exit_date,
            c.site_manager_note
        FROM employee_exit_cases c
        JOIN employees e
          ON e.id = c.employee_id
         AND e.org_id = c.org_id
        LEFT JOIN branches b
          ON b.id = c.branch_id
         AND b.org_id = c.org_id
        WHERE c.org_id =
        "#,
    );
    builder.push_bind(org_uuid);
    builder.push(" AND c.id = ");
    builder.push_bind(case_id);
    if lock_case {
        builder.push(" FOR UPDATE OF c");
    }

    let row = builder
        .build()
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| HrError::from_kernel(KernelError::not_found("exit case not found")))?;

    Ok(ExitCaseContext {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        employee_name: row.try_get("employee_name")?,
        employee_number: row.try_get("employee_number")?,
        company: row.try_get("company")?,
        org_unit: row.try_get("org_unit")?,
        position: row.try_get("position")?,
        worksite_name: row.try_get("worksite_name")?,
        hire_date: row.try_get("hire_date")?,
        branch_id: row.try_get("branch_id")?,
        branch_name: row.try_get("branch_name")?,
        status: row.try_get("status")?,
        hr_confirmed_by: row.try_get("hr_confirmed_by")?,
        effective_exit_date: row.try_get("effective_exit_date")?,
        site_manager_note: row.try_get("site_manager_note")?,
    })
}

pub async fn resolve_exit_case_branch(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
    requested_branch_id: Option<Uuid>,
    absence_alert_id: Option<Uuid>,
) -> Result<Option<Uuid>, HrError> {
    // The employee row is durable authority; a client-supplied branch never is.
    // FOR SHARE holds the home-branch decision stable until the exit case lands.
    let employee_branch: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT home_branch_id FROM employees WHERE org_id = $1 AND id = $2 FOR SHARE",
    )
    .bind(org_uuid)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(employee_branch) = employee_branch else {
        return Err(HrError::from_kernel(KernelError::not_found(
            "employee not found",
        )));
    };

    // When an alert is named it must exist for this exact employee. Distinguish
    // a missing row from a real alert whose branch is NULL; silently falling
    // through would let a fabricated or stale alert id acquire authority.
    let alert_branch = if let Some(alert_id) = absence_alert_id {
        let row: Option<Option<Uuid>> = sqlx::query_scalar(
            r#"
            SELECT branch_id
            FROM employee_absence_alerts
            WHERE org_id = $1 AND id = $2 AND employee_id = $3
            FOR UPDATE
            "#,
        )
        .bind(org_uuid)
        .bind(alert_id)
        .bind(employee_id)
        .fetch_optional(tx.as_mut())
        .await?;
        let Some(branch_id) = row else {
            return Err(HrError::from_kernel(KernelError::not_found(
                "absence alert not found for employee",
            )));
        };
        branch_id
    } else {
        None
    };

    // An alert is the strongest evidence for an absence-driven report; otherwise
    // use the employee's durable home branch, then the latest imported attendance
    // fact. A missing branch stays missing and requires org-wide authorization.
    let derived_branch = if let Some(branch_id) = alert_branch.or(employee_branch) {
        Some(branch_id)
    } else {
        sqlx::query_scalar(
            r#"
            SELECT branch_id
            FROM attendance_direct_import_events
            WHERE org_id = $1 AND employee_id = $2
            ORDER BY work_date DESC, created_at DESC, id DESC
            LIMIT 1
            "#,
        )
        .bind(org_uuid)
        .bind(employee_id)
        .fetch_optional(tx.as_mut())
        .await?
    };

    if let Some(requested_branch_id) = requested_branch_id
        && derived_branch != Some(requested_branch_id)
    {
        return Err(HrError::from_kernel(KernelError::not_found(
            "employee or absence alert was not found in the requested branch",
        )));
    }
    Ok(derived_branch)
}

pub async fn insert_confirmed_exit_lifecycle_event(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    context: &ExitCaseContext,
    note: Option<&str>,
    signoffs: EmployeeLifecycleSignoffs,
) -> Result<Option<Uuid>, HrError> {
    let org_uuid = *org.as_uuid();
    let current = load_employee_for_lifecycle(tx, org_uuid, context.employee_id).await?;
    // Only import leaves someone EXITED outside a case: nothing to record or reverse.
    if normalize_enum_text(current.employment_status.clone()) == "EXITED" {
        return Ok(None);
    }
    let transition = NormalizedEmployeeLifecycleTransition {
        event_type: "TERMINATE".to_owned(),
        to_status: "EXITED".to_owned(),
        to_company: None,
        to_org_unit: None,
        to_org_unit_id: None,
        to_position: None,
        expected_return_date: None,
        contract_end_date: None,
        leave_type: None,
        to_job_title_id: None,
        reason_code: None,
        to_workplace_id: None,
        classify: Default::default(),
        effective_date: context.effective_exit_date.clone(),
        // The history shows why the employee left: the reported reason, or
        // the confirmer's memo when one was given.
        comment: note.map_or_else(|| context.site_manager_note.clone(), ToOwned::to_owned),
        signoffs,
    };
    // Dated after today (KST) it is SCHEDULED, else it exits them now; pending
    // events are withdrawn first (an exit refuses them all).
    let prepared =
        prepare_lifecycle_event(tx, org_uuid, context.employee_id, transition, today_kst()).await?;
    let (item, _) =
        record_lifecycle_event_tx(tx, org, actor, context.employee_id, &prepared, None).await?;
    end_assignment(tx.as_mut(), org_uuid, actor, context, item.id).await?;
    Ok(Some(item.id))
}

/// The compensating half of [`insert_confirmed_exit_lifecycle_event`]: when the
/// case's HR confirmation exited the employee, record an EXIT_REVERSAL event
/// (EXITED -> the status the exit replaced) and restore the employment head
/// (which clears `exit_date`). Returns the reversal event id and the restored
/// status; `None` when the case never exited anyone.
pub async fn reverse_exit_lifecycle_event(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: UserId,
    context: &ExitCaseContext,
    reason: &str,
) -> Result<Option<(Uuid, String)>, HrError> {
    // The employee first, then the event: the lock order every writer shares.
    let current = load_employee_for_lifecycle(tx, org_uuid, context.employee_id).await?;
    let linked: Option<(Uuid, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT l.id, l.state, l.from_status
        FROM employee_exit_cases c
        JOIN employee_lifecycle_events l
          ON l.id = c.exit_lifecycle_event_id
         AND l.org_id = c.org_id
        WHERE c.org_id = $1 AND c.id = $2
        FOR UPDATE OF l
        "#,
    )
    .bind(org_uuid)
    .bind(context.id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((exit_event_id, exit_state, prior)) = linked else {
        return Ok(None);
    };
    // Whatever became of the TERMINATE, the assignment its confirmation ended runs on.
    reopen_assignment(tx.as_mut(), org_uuid, actor, context).await?;
    match exit_state.as_str() {
        "APPLIED" => {}
        // Not yet in effect: withdrawing the scheduled exit is the reversal.
        "SCHEDULED" => {
            cancel_scheduled_lifecycle_event_tx(tx, org_uuid, exit_event_id, actor, reason).await?;
            return Ok(None);
        }
        // APPLY_FAILED / CANCELLED: the exit never took effect.
        _ => return Ok(None),
    }
    let restored = prior
        .map(normalize_enum_text)
        .filter(|status| matches!(status.as_str(), "ACTIVE" | "ON_LEAVE" | "UNKNOWN"))
        .unwrap_or_else(|| "UNKNOWN".to_owned());
    // EXITED admits no lifecycle event, so nothing can have moved the employee
    // since this case exited them — unless an import rewrote the head.
    if normalize_enum_text(current.employment_status.clone()) != "EXITED" {
        return Err(lifecycle_refusal(
            "employee is no longer EXITED; the exit cannot be reversed",
        ));
    }
    let effective_date = today_kst().to_string();
    let lifecycle_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO employee_lifecycle_events (
            id, org_id, employee_id, event_type, from_status, to_status,
            from_company, to_company, from_org_unit, to_org_unit,
            from_position, to_position, effective_date, comment,
            signoffs, created_by
        )
        VALUES (
            $1, $2, $3, 'EXIT_REVERSAL', $4, $5,
            $6, $6, $7, $7,
            $8, $8, $9, $10,
            '{}'::jsonb, $11
        )
        "#,
    )
    .bind(lifecycle_id)
    .bind(org_uuid)
    .bind(context.employee_id)
    .bind(&current.employment_status)
    .bind(&restored)
    .bind(&current.company)
    .bind(current.org_unit.as_deref())
    .bind(current.position.as_deref())
    .bind(&effective_date)
    .bind(reason)
    .bind(*actor.as_uuid())
    .execute(tx.as_mut())
    .await?;
    employment::apply_employment_change(
        tx,
        org_uuid,
        context.employee_id,
        employment::EmploymentChange {
            company: &current.company,
            org_unit: current.org_unit.as_deref(),
            position: current.position.as_deref(),
            employment_status: &restored,
            effective_date: &effective_date,
        },
    )
    .await?;
    Ok(Some((lifecycle_id, restored)))
}
