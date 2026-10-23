//! Resolving a bulk correction's employees: the server-side selection (the
//! roster filters minus exclusions) or the grid's rows, in id order (the lock
//! order of every bulk HR write, so two never deadlock).

use std::collections::BTreeSet;

use serde_json::{Map, Value};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{BulkCorrectionRequest, BulkSelection, MAX_BULK_CORRECTION_ROWS};
use crate::HrError;
use crate::directory::read_list::{EmployeeListFilters, EmployeeListQuery, filtered_employees};
use console_kernel_core::BranchScope;

/// One employee to plan: the values to write and the grid's pin, if any.
pub(super) struct RowInput {
    pub employee_id: Uuid,
    pub changes: Map<String, Value>,
    pub expected_updated_at: Option<OffsetDateTime>,
}

fn filters(selection: &BulkSelection) -> Result<EmployeeListFilters, HrError> {
    let f = &selection.filter;
    let mut filters = EmployeeListFilters::from_query(
        &EmployeeListQuery {
            company: f.company.clone(),
            search: f.search.clone(),
            home_branch_review_required: f.home_branch_review_required,
            identity_review_required: f.identity_review_required,
            register_review_required: f.register_review_required,
            org_unit_id: f.org_unit_id,
            status: f.status.clone(),
            contract_ending_before: f.contract_ending_before.clone(),
            lifecycle_apply_failed: f.lifecycle_apply_failed,
            ..EmployeeListQuery::default()
        },
        &BranchScope::All,
    )?; // the commit is authorized org-wide (authorize_hr_org_wide)
    if filters.statuses.is_empty() {
        filters.statuses = ["ACTIVE", "ON_LEAVE", "UNKNOWN"]
            .map(str::to_owned)
            .to_vec();
    }
    Ok(filters)
}

fn too_many(count: usize) -> HrError {
    HrError {
        errors: None,
        status: http::StatusCode::UNPROCESSABLE_ENTITY,
        code: "bulk_selection_too_large",
        message: format!(
            "{count} employees are selected; one bulk correction takes at most {MAX_BULK_CORRECTION_ROWS}"
        ),
        refusals: Some(Box::new(
            serde_json::json!([{ "selected": count, "max": MAX_BULK_CORRECTION_ROWS }]),
        )),
    }
}

fn pin(raw: Option<&str>) -> Result<Option<OffsetDateTime>, HrError> {
    raw.map(|raw| {
        OffsetDateTime::parse(raw.trim(), &time::format_description::well_known::Rfc3339)
            .map_err(|_| HrError::validation("expected_updated_at must be an RFC 3339 timestamp"))
    })
    .transpose()
}

/// The request's shape: selection + changes, or rows; checked before any read.
pub(super) fn check_shape(body: &BulkCorrectionRequest) -> Result<(), HrError> {
    match (&body.selection, &body.changes, body.rows.is_empty()) {
        (Some(_), Some(changes), true) if !changes.is_empty() => Ok(()),
        (None, None, false) if body.rows.len() <= MAX_BULK_CORRECTION_ROWS => {
            if body.rows.iter().any(|row| row.changes.is_empty()) {
                return Err(HrError::validation(
                    "every row must change at least one field",
                ));
            }
            let distinct: BTreeSet<Uuid> = body.rows.iter().map(|row| row.employee_id).collect();
            if distinct.len() == body.rows.len() {
                Ok(())
            } else {
                Err(HrError::validation("rows must not repeat an employee"))
            }
        }
        (None, None, false) => Err(too_many(body.rows.len())),
        _ => Err(HrError::validation(
            "send either selection with changes, or rows; changes must name at least one field",
        )),
    }
}

/// Every employee the request names, in id order, with its values.
pub(super) async fn resolve(
    tx: &mut Transaction<'_, Postgres>,
    body: &BulkCorrectionRequest,
) -> Result<Vec<RowInput>, HrError> {
    let (Some(selection), Some(changes)) = (&body.selection, &body.changes) else {
        let mut rows = body
            .rows
            .iter()
            .map(|row| {
                Ok(RowInput {
                    employee_id: row.employee_id,
                    changes: row.changes.clone(),
                    expected_updated_at: pin(row.expected_updated_at.as_deref())?,
                })
            })
            .collect::<Result<Vec<_>, HrError>>()?;
        rows.sort_by_key(|row| row.employee_id);
        return Ok(rows);
    };
    let filters = filters(selection)?;
    let mut query = filtered_employees("SELECT e.id", &filters);
    query.push(" AND NOT (e.id = ANY(");
    query.push_bind(selection.exclude_ids.clone());
    query.push(")) ORDER BY e.id");
    let ids: Vec<Uuid> = query.build_query_scalar().fetch_all(tx.as_mut()).await?;
    if ids.is_empty() {
        return Err(HrError::validation("the selection matches no employee"));
    }
    if ids.len() > MAX_BULK_CORRECTION_ROWS {
        return Err(too_many(ids.len()));
    }
    Ok(ids
        .into_iter()
        .map(|employee_id| RowInput {
            employee_id,
            changes: changes.clone(),
            expected_updated_at: None,
        })
        .collect())
}
