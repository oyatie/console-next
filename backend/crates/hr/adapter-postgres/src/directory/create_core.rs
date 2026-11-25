//! The transactional employee-create core (moved from `app/src/hr.rs`,
//! R2-people).

use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_adapter_postgres::employment;
use console_ontology_canonical_adapter_postgres::person::{PersonCommand, create_many_in_tx};
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::clock::today_kst;
use crate::directory::create::employee_create_db_error;
use crate::directory::create_facts::record_registration_facts;
use crate::directory::create_guard::revalidate_directory_manager;
use crate::directory::create_onboard::{
    RegistrationOnboard, is_pre_hire, mark_pre_hire, record_registration_onboards,
};
use crate::directory::create_prepare::{
    PreparedRegistration, RegistrationInput, prepare_registrations,
};
use crate::directory::read_detail::load_employee_detail_unfiltered;
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
    create_employees_core(
        tx,
        org_uuid,
        actor,
        &[RegistrationInput {
            request,
            request_hash,
            employee_id,
        }],
    )
    .await?
    .pop()
    .ok_or_else(|| sqlx::Error::RowNotFound.into())
}

/// Multi-registration core, in input order, sharing the single registration's write owners.
/// Results omit warnings because only the caller has the reader's directory scope.
/// Callers must normalize requests, authorize, admit duplicates, place, audit and roll back
/// on error, exactly as for `create_employee_core`; this is not an authorization boundary.
pub async fn create_employees_core(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: UserId,
    inputs: &[RegistrationInput<'_>],
) -> Result<Vec<(EmployeeDetailResponse, bool)>, HrError> {
    let prepared = write_registrations_core(tx, org_uuid, actor, inputs).await?;
    let mut results = Vec::with_capacity(prepared.len());
    for row in prepared {
        results.push((
            load_employee_detail_unfiltered(tx, org_uuid, row.employee_id).await?,
            row.replayed,
        ));
    }
    Ok(results)
}

/// Register a batch without reading full directory details for each result.
/// Bulk callers consume identities while single-person callers need employee detail.
/// Callers own authorization, duplicate admission, placement, audit and rollback on error.
pub async fn write_registrations_core(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: UserId,
    inputs: &[RegistrationInput<'_>],
) -> Result<Vec<PreparedRegistration>, HrError> {
    revalidate_directory_manager(tx, org_uuid, actor).await?;
    let prepared = prepare_registrations(tx, org_uuid, inputs).await?;
    let fresh: Vec<_> = inputs
        .iter()
        .zip(&prepared)
        .filter(|(_, row)| !row.replayed)
        .collect();
    let records: Vec<_> = fresh
        .iter()
        .map(|(input, row)| employment::NewEmployeeRecord {
            employee_id: row.employee_id,
            company: &input.request.company,
            name: &input.request.name,
            employee_number: &row.employee_number,
            org_unit: &row.org_unit,
            position: &input.request.position,
            worksite_name: &input.request.site,
            hire_date: input.request.hire_date.as_deref(),
        })
        .collect();
    employment::insert_employee_records(tx, org_uuid, &records)
        .await
        .map_err(employee_create_db_error)?;
    let today = today_kst();
    let mut units = Vec::new();
    let mut appointments = Vec::new();
    for (input, row) in &fresh {
        let request = input.request;
        let pre_hire = is_pre_hire(request.hire_date.as_deref(), today)?;
        if pre_hire {
            mark_pre_hire(tx, org_uuid, row.employee_id).await?;
        } else {
            appointments.push(row.employee_id);
        }
        if let Some(unit) = request.org_unit_id {
            units.push((row.employee_id, unit));
        }
    }
    employment::set_employee_org_units(tx, org_uuid, &units).await?;
    employment::appoint_legacy_heads_in_tx(tx, OrgId::from_uuid(org_uuid), actor, &appointments)
        .await?;
    let persons: Vec<_> = fresh
        .iter()
        .map(|(input, row)| {
            PersonCommand::create_bound(
                OrgId::from_uuid(org_uuid),
                actor,
                row.employee_id,
                &input.request.name,
            )
        })
        .collect();
    create_many_in_tx(tx, &persons).await?;
    if !fresh.is_empty() {
        sqlx::query(
            r#"INSERT INTO employee_employment_profiles (
                employee_id, org_id, employment_type, phone_e164, base_pay,
                idempotency_key, request_hash, created_by, contract_start_date, contract_end_date
            ) SELECT id,$1,kind,phone,pay::numeric,key,hash,$2,start_date::DATE,end_date::DATE
              FROM unnest($3::uuid[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[])
              AS input(id,kind,phone,pay,key,hash,start_date,end_date)"#,
        )
        .bind(org_uuid).bind(actor.as_uuid())
        .bind(fresh.iter().map(|(_, r)| r.employee_id).collect::<Vec<_>>())
        .bind(fresh.iter().map(|(i, _)| i.request.employment_type.as_deref()).collect::<Vec<_>>())
        .bind(fresh.iter().map(|(i, _)| i.request.phone_e164.as_deref()).collect::<Vec<_>>())
        .bind(fresh.iter().map(|(i, _)| i.request.base_pay.as_deref()).collect::<Vec<_>>())
        .bind(fresh.iter().map(|(i, _)| i.request.idempotency_key.as_str()).collect::<Vec<_>>())
        .bind(fresh.iter().map(|(i, _)| i.request_hash).collect::<Vec<_>>())
        .bind(fresh.iter().map(|(i, _)| i.request.contract_start_date.as_deref()).collect::<Vec<_>>())
        .bind(fresh.iter().map(|(i, _)| i.request.contract_end_date.as_deref()).collect::<Vec<_>>())
        .execute(tx.as_mut()).await.map_err(employee_create_db_error)?;
    }
    for (input, row) in &fresh {
        let request = input.request;
        record_registration_facts(
            tx,
            org_uuid,
            row.employee_id,
            *actor.as_uuid(),
            &request.facts,
        )
        .await?;
    }
    let onboards: Vec<_> = fresh
        .iter()
        .map(|(input, row)| {
            let request = input.request;
            (
                row.employee_id,
                RegistrationOnboard {
                    company: &request.company,
                    org_unit: &row.org_unit,
                    org_unit_id: request.org_unit_id,
                    position: &request.position,
                    hire_date: request.hire_date.as_deref(),
                },
            )
        })
        .collect();
    record_registration_onboards(tx, org_uuid, *actor.as_uuid(), &onboards, today).await?;
    if !fresh.is_empty() {
        sqlx::query(
            "UPDATE employee_create_idempotency SET employee_id = input.id \
             FROM unnest($2::text[],$3::uuid[]) AS input(key,id) \
             WHERE org_id=$1 AND idempotency_key=input.key",
        )
        .bind(org_uuid)
        .bind(
            fresh
                .iter()
                .map(|(i, _)| i.request.idempotency_key.as_str())
                .collect::<Vec<_>>(),
        )
        .bind(fresh.iter().map(|(_, r)| r.employee_id).collect::<Vec<_>>())
        .execute(tx.as_mut())
        .await?;
    }
    Ok(prepared)
}
