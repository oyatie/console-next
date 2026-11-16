//! The transactional employee-create core (moved from `app/src/hr.rs`,
//! R2-people).

use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_adapter_postgres::employment;
use console_ontology_canonical_adapter_postgres::person::{
    PersonCommand, write_in_tx as write_person_in_tx,
};
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::clock::today_kst;
use crate::directory::create::employee_create_db_error;
use crate::directory::create_facts::record_registration_facts;
use crate::directory::create_guard::revalidate_directory_manager;
use crate::directory::create_onboard::{
    RegistrationOnboard, is_pre_hire, mark_pre_hire, record_registration_onboard,
};
use crate::directory::create_prepare::{RegistrationInput, prepare_registrations};
use crate::directory::read_detail::load_employee_detail;
use crate::directory::types::{EmployeeDetailResponse, NormalizedCreateEmployeeRequest};

/// The transactional core of employee creation — the ONLY write path into
/// `employees` + `employee_employment_profiles`. Shared by the People &
/// Workforce endpoint above and the recruiting hire handshake
/// (`recruiting_hire`), which calls it inside its own `with_audits`
/// transaction so the employee row and the recruiting linkage commit
/// atomically. Same idempotency reservation, same tables, same lifecycle
/// event. Callers own authorization and append the `employee.create` audit
/// (from [`employee_create_audit`]) only when `replayed` is false.
pub async fn create_employee_core(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: UserId,
    request: &NormalizedCreateEmployeeRequest,
    request_hash: &str,
    employee_id: Uuid,
) -> Result<(EmployeeDetailResponse, bool), HrError> {
    revalidate_directory_manager(tx, org_uuid, actor).await?;
    let prepared = prepare_registrations(
        tx,
        org_uuid,
        &[RegistrationInput {
            request,
            request_hash,
            employee_id,
        }],
    )
    .await?
    .pop()
    .ok_or(sqlx::Error::RowNotFound)?;
    if prepared.replayed {
        return Ok((
            load_employee_detail(tx, org_uuid, prepared.employee_id).await?,
            true,
        ));
    }
    let org_unit_text = prepared.org_unit;
    let employee_number = prepared.employee_number;

    // The statement itself lives in `console-ontology-canonical-adapter-postgres`,
    // which the canonical contract names as `ObjectKey::Employment`'s owner — the
    // one crate permitted to hold DML against `employees`. It takes THIS
    // transaction, so the employee row, its employment profile, its lifecycle
    // event and the idempotency reservation still commit or roll back together.
    //
    // home_branch_id is intentionally NOT inserted: since 0166 the branch
    // routing authority is command-only (the console_rt guard rejects it), so the
    // caller establishes it post-commit via [`assign_home_branch_if_unset`].
    employment::insert_employee_record(
        tx,
        org_uuid,
        employment::NewEmployeeRecord {
            employee_id,
            company: &request.company,
            name: &request.name,
            employee_number: &employee_number,
            org_unit: &org_unit_text,
            position: &request.position,
            worksite_name: &request.site,
            hire_date: request.hire_date.as_deref(),
        },
    )
    .await
    .map_err(employee_create_db_error)?;
    let today = today_kst();
    let pre_hire = is_pre_hire(request.hire_date.as_deref(), today)?;
    if pre_hire {
        mark_pre_hire(tx, org_uuid, employee_id).await?;
    }
    if let Some(org_unit_id) = request.org_unit_id {
        employment::set_employee_org_unit(tx, org_uuid, employee_id, Some(org_unit_id), None)
            .await?;
    }
    // The canonical employment (head + revision + source binding) opens in
    // the same transaction, through the Employment owner: without it an
    // org-change REASSIGN_ORG_UNIT refuses this employee as unbound. A
    // PRE_HIRE person is not employed yet: the scheduled ONBOARD opens it on
    // the hire date (HrService::apply_due).
    if !pre_hire {
        employment::appoint_legacy_head_in_tx(tx, OrgId::from_uuid(org_uuid), actor, employee_id)
            .await?;
    }
    // Directory create mints the Person in the same transaction (person_id =
    // employee_id).
    write_person_in_tx(
        tx,
        &PersonCommand::create_bound(
            OrgId::from_uuid(org_uuid),
            actor,
            employee_id,
            &request.name,
        ),
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO employee_employment_profiles (
            employee_id, org_id, employment_type, phone_e164, base_pay,
            idempotency_key, request_hash, created_by,
            contract_start_date, contract_end_date
        ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9::DATE, $10::DATE)"#,
    )
    .bind(employee_id)
    .bind(org_uuid)
    .bind(&request.employment_type)
    .bind(&request.phone_e164)
    .bind(&request.base_pay)
    .bind(&request.idempotency_key)
    .bind(request_hash)
    .bind(*actor.as_uuid())
    .bind(request.contract_start_date.as_deref())
    .bind(request.contract_end_date.as_deref())
    .execute(tx.as_mut())
    .await
    .map_err(employee_create_db_error)?;
    record_registration_facts(tx, org_uuid, employee_id, *actor.as_uuid(), &request.facts).await?;
    record_registration_onboard(
        tx,
        org_uuid,
        *actor.as_uuid(),
        employee_id,
        &RegistrationOnboard {
            company: &request.company,
            org_unit: &org_unit_text,
            org_unit_id: request.org_unit_id,
            position: &request.position,
            hire_date: request.hire_date.as_deref(),
        },
        today,
    )
    .await?;
    sqlx::query(
        "UPDATE employee_create_idempotency SET employee_id = $3 WHERE org_id = $1 AND idempotency_key = $2",
    )
    .bind(org_uuid).bind(&request.idempotency_key).bind(employee_id)
    .execute(tx.as_mut()).await?;
    Ok((
        load_employee_detail(tx, org_uuid, employee_id).await?,
        false,
    ))
}
