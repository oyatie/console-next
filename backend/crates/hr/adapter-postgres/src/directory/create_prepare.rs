// SPDX-License-Identifier: LicenseRef-Proprietary
//! Registration preparation shared by single and multi-person writers.
use std::collections::{BTreeMap, BTreeSet};

use console_kernel_core::KernelError;
use console_ontology_canonical_adapter_postgres::employment::{
    EmploymentError, assignable_org_units,
};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::create::{
    employee_create_db_error, format_employee_number, next_employee_sequence, sequence_of,
};
use super::create_checks::employee_number_taken;
use super::create_guard::registration_key_reused;
use super::types::NormalizedCreateEmployeeRequest;
use crate::HrError;

pub struct RegistrationInput<'a> {
    pub request: &'a NormalizedCreateEmployeeRequest,
    pub request_hash: &'a str,
    pub employee_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct PreparedRegistration {
    pub employee_id: Uuid,
    pub replayed: bool,
    pub org_unit: String,
    pub employee_number: String,
}

/// Reserves in key order so overlapping batches acquire row locks consistently.
/// Callers must roll back their transaction on any preparation or write error.
pub async fn reserve_create_keys(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    inputs: &[(&str, &str)],
) -> Result<BTreeMap<String, Option<Uuid>>, HrError> {
    let mut unique = BTreeMap::new();
    for &(key, hash) in inputs {
        if unique
            .insert(key, hash)
            .is_some_and(|stored| stored != hash)
        {
            return Err(registration_key_reused());
        }
    }
    if unique.is_empty() {
        return Ok(BTreeMap::new());
    }
    let keys: Vec<_> = unique.keys().copied().collect();
    let hashes: Vec<_> = unique.values().copied().collect();
    sqlx::query(
        "INSERT INTO employee_create_idempotency (org_id,idempotency_key,request_hash) \
        SELECT $1,k,h FROM unnest($2::text[],$3::text[]) AS input(k,h) ORDER BY k \
        ON CONFLICT (org_id,idempotency_key) DO NOTHING",
    )
    .bind(org)
    .bind(&keys)
    .bind(&hashes)
    .execute(tx.as_mut())
    .await
    .map_err(employee_create_db_error)?;
    let rows: Vec<(String, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT idempotency_key,request_hash,employee_id FROM employee_create_idempotency \
         WHERE org_id=$1 AND idempotency_key=ANY($2) ORDER BY idempotency_key FOR UPDATE",
    )
    .bind(org)
    .bind(&keys)
    .fetch_all(tx.as_mut())
    .await?;
    let mut reserved = BTreeMap::new();
    for (key, hash, employee) in rows {
        if unique.get(key.as_str()).copied() != Some(hash.as_str()) {
            return Err(registration_key_reused());
        }
        reserved.insert(key, employee);
    }
    if reserved.len() != unique.len() {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(reserved)
}

/// Prepare after the caller's live manager check, inside its org-armed transaction.
/// Repeated keys share the first employee; only its first occurrence needs writes.
/// Duplicate-person admission, placement and audit remain the registration caller's job.
pub async fn prepare_registrations(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    inputs: &[RegistrationInput<'_>],
) -> Result<Vec<PreparedRegistration>, HrError> {
    let keys: Vec<_> = inputs
        .iter()
        .map(|i| (i.request.idempotency_key.as_str(), i.request_hash))
        .collect();
    let reserved = reserve_create_keys(tx, org, &keys).await?;
    let fresh: Vec<_> = inputs
        .iter()
        .filter(|i| reserved[&i.request.idempotency_key].is_none())
        .collect();
    let branches: Vec<_> = fresh
        .iter()
        .filter_map(|i| i.request.home_branch_id)
        .collect();
    let units: Vec<_> = fresh
        .iter()
        .filter_map(|i| {
            i.request
                .org_unit_id
                .or_else(|| Uuid::parse_str(&i.request.org_unit).ok())
        })
        .collect();
    let positions: Vec<_> = fresh
        .iter()
        .filter_map(|i| Uuid::parse_str(&i.request.position).ok())
        .collect();
    let units = assignable_org_units(tx, org, &units).await?;
    let mut refs = BTreeSet::new();
    if !branches.is_empty() || !positions.is_empty() {
        let rows: Vec<(String, Uuid)> = sqlx::query_as(
            "WITH registration_refs AS ( \
             SELECT 'branch'::text AS kind,id FROM branches \
             WHERE org_id=$1 AND id=ANY($2) AND deactivated_at IS NULL \
             UNION ALL SELECT 'position',id FROM job_positions WHERE org_id=$1 AND id=ANY($3) \
             ) SELECT kind,id FROM registration_refs",
        )
        .bind(org)
        .bind(&branches)
        .bind(&positions)
        .fetch_all(tx.as_mut())
        .await?;
        refs.extend(rows);
    }
    let mut prepared: BTreeMap<&str, PreparedRegistration> = BTreeMap::new();
    let mut numbers = BTreeSet::new();
    let mut next = None;
    let mut manual_max = 0;
    let mut result = Vec::with_capacity(inputs.len());
    for input in inputs {
        let request = input.request;
        if let Some(previous) = prepared.get(request.idempotency_key.as_str()) {
            result.push(PreparedRegistration {
                replayed: true,
                ..previous.clone()
            });
            continue;
        }
        let replay = reserved[&request.idempotency_key];
        let mut row = PreparedRegistration {
            employee_id: replay.unwrap_or(input.employee_id),
            replayed: replay.is_some(),
            org_unit: request.org_unit.clone(),
            employee_number: request.employee_number.clone(),
        };
        if !row.replayed {
            if let Some(branch) = request.home_branch_id
                && !refs.contains(&("branch".into(), branch))
            {
                return Err(KernelError::not_found(
                    "active home branch was not found in this organization",
                )
                .into());
            }
            if let Some(unit) = request.org_unit_id {
                match units.get(&unit) {
                    None => {
                        return Err(KernelError::not_found(
                            "org unit was not found in this organization",
                        )
                        .into());
                    }
                    Some(None) => {
                        return Err(HrError::validation(
                            "org_unit_id must be an ACTIVE site, department, or team",
                        ));
                    }
                    Some(Some(name)) => row.org_unit = name.clone(),
                }
            } else if let Ok(unit) = Uuid::parse_str(&request.org_unit)
                && !units.contains_key(&unit)
            {
                return Err(EmploymentError::UnknownOrgUnit(unit).into());
            }
            if let Ok(position) = Uuid::parse_str(&request.position)
                && !refs.contains(&("position".into(), position))
            {
                return Err(EmploymentError::UnknownJobPosition(position).into());
            }
            if row.employee_number.is_empty() {
                let candidate = match next {
                    Some(value) => value,
                    None => next_employee_sequence(tx, org).await?,
                }
                .max(manual_max + 1);
                row.employee_number = format_employee_number(candidate);
                next = Some(candidate + 1);
            } else if let Some(sequence) = sequence_of(&row.employee_number) {
                manual_max = manual_max.max(sequence);
            }
            if !numbers.insert(row.employee_number.clone()) {
                return Err(employee_number_taken(None));
            }
        }
        prepared.insert(&request.idempotency_key, row.clone());
        result.push(row);
    }
    Ok(result)
}
