// SPDX-License-Identifier: LicenseRef-Proprietary
//! Registration preparation shared by single and multi-person writers.
use std::collections::{BTreeMap, BTreeSet};

use console_kernel_core::KernelError;
use console_ontology_canonical_adapter_postgres::employment::EmploymentError;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::create::{employee_create_db_error, next_employee_number};
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
    let mut refs = BTreeMap::new();
    if !branches.is_empty() || !units.is_empty() || !positions.is_empty() {
        let rows: Vec<(String, Uuid, Option<String>, bool)> = sqlx::query_as(
            "WITH registration_refs AS ( \
             SELECT 'branch'::text AS kind,id,NULL::text AS name,true AS assignable FROM branches \
             WHERE org_id=$1 AND id=ANY($2) AND deactivated_at IS NULL \
             UNION ALL SELECT 'unit',u.id,r.attributes->>'name',COALESCE( \
               r.attributes->>'kind' IN ('site','department','team') \
               AND COALESCE(r.attributes->>'status','active') <> 'dissolved',false) \
             FROM org_units u LEFT JOIN LATERAL (SELECT attributes FROM org_unit_revisions \
               WHERE org_id=u.org_id AND org_unit_id=u.id ORDER BY version DESC LIMIT 1) r ON true \
             WHERE u.org_id=$1 AND u.id=ANY($3) \
             UNION ALL SELECT 'position',id,NULL::text,true FROM job_positions WHERE org_id=$1 AND id=ANY($4) \
             ) SELECT kind,id,name,assignable FROM registration_refs",
        ).bind(org).bind(&branches).bind(&units).bind(&positions).fetch_all(tx.as_mut()).await?;
        for (kind, id, name, assignable) in rows {
            refs.insert((kind, id), (name, assignable));
        }
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
                && !refs.contains_key(&("branch".into(), branch))
            {
                return Err(KernelError::not_found(
                    "active home branch was not found in this organization",
                )
                .into());
            }
            if let Some(unit) = request.org_unit_id {
                match refs.get(&("unit".into(), unit)) {
                    None => {
                        return Err(KernelError::not_found(
                            "org unit was not found in this organization",
                        )
                        .into());
                    }
                    Some((_, false)) => {
                        return Err(HrError::validation(
                            "org_unit_id must be an ACTIVE site, department, or team",
                        ));
                    }
                    Some((name, true)) => {
                        row.org_unit = name.clone().ok_or(sqlx::Error::RowNotFound)?
                    }
                }
            } else if let Ok(unit) = Uuid::parse_str(&request.org_unit)
                && !refs.contains_key(&("unit".into(), unit))
            {
                return Err(EmploymentError::UnknownOrgUnit(unit).into());
            }
            if let Ok(position) = Uuid::parse_str(&request.position)
                && !refs.contains_key(&("position".into(), position))
            {
                return Err(EmploymentError::UnknownJobPosition(position).into());
            }
            if row.employee_number.is_empty() {
                let candidate = match next {
                    Some(value) => value,
                    None => next_employee_number(tx, org).await?[2..]
                        .parse::<i64>()
                        .map_err(|_| HrError::validation("employee number sequence is invalid"))?,
                }
                .max(manual_max + 1);
                row.employee_number = format!("E-{candidate:06}");
                next = Some(candidate + 1);
            } else if let Some(digits) = row.employee_number.strip_prefix("E-")
                && (6..=18).contains(&digits.len())
                && digits.bytes().all(|b| b.is_ascii_digit())
            {
                manual_max = manual_max.max(
                    digits
                        .parse::<i64>()
                        .map_err(|_| HrError::validation("employee number is invalid"))?,
                );
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
