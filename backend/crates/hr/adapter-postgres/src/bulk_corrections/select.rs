//! Resolving a bulk correction's employees: the server-side selection (the
//! roster filters minus exclusions) or the grid's rows, in id order (the lock
//! order of every bulk HR write, so two never deadlock).

use serde_json::{Map, Value};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{
    BulkCorrectionRefusal, BulkCorrectionRow, BulkSelection, MAX_BULK_CORRECTION_ROWS, row_refusal,
};
use crate::HrError;
use crate::corrections::{CheckedChange, check_change};
use crate::directory::read_list::{EmployeeListFilters, EmployeeListQuery, filtered_employees};
use console_kernel_core::BranchScope;

/// Checked changes shared by a selection or supplied for individual employees.
pub(super) enum Targets {
    Selection {
        selection: BulkSelection,
        changes: Vec<CheckedChange>,
    },
    Grid(Vec<GridRow>),
}

pub(super) struct GridRow {
    employee_id: Uuid,
    changes: Vec<CheckedChange>,
    refusals: Vec<BulkCorrectionRefusal>,
    expected_updated_at: Option<OffsetDateTime>,
}

/// One employee's checked values, field refusals and optional grid pin.
pub(super) struct RowInput<'a> {
    pub employee_id: Uuid,
    pub changes: &'a [CheckedChange],
    pub refusals: Vec<BulkCorrectionRefusal>,
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

/// Check values and pins before any read. Invalid grid values stay with their row.
pub(super) fn check_targets(
    selection: Option<BulkSelection>,
    changes: Option<Map<String, Value>>,
    mut rows: Vec<BulkCorrectionRow>,
) -> Result<Targets, HrError> {
    match (selection, changes, rows.is_empty()) {
        (Some(selection), Some(changes), true) if !changes.is_empty() => {
            let fields = changes
                .iter()
                .map(|(field, value)| check_change(field, value))
                .collect::<Result<_, _>>()?;
            Ok(Targets::Selection {
                selection,
                changes: fields,
            })
        }
        (None, None, false) if rows.len() <= MAX_BULK_CORRECTION_ROWS => {
            if rows.iter().any(|row| row.changes.is_empty()) {
                return Err(HrError::validation(
                    "every row must change at least one field",
                ));
            }
            rows.sort_by_key(|row| row.employee_id);
            if rows
                .windows(2)
                .any(|pair| pair[0].employee_id == pair[1].employee_id)
            {
                return Err(HrError::validation("rows must not repeat an employee"));
            }
            rows.into_iter()
                .map(grid_row)
                .collect::<Result<_, _>>()
                .map(Targets::Grid)
        }
        (None, None, false) => Err(too_many(rows.len())),
        _ => Err(HrError::validation(
            "send either selection with changes, or rows; changes must name at least one field",
        )),
    }
}

fn grid_row(row: BulkCorrectionRow) -> Result<GridRow, HrError> {
    let expected_updated_at = pin(row.expected_updated_at.as_deref())?;
    let mut changes = Vec::with_capacity(row.changes.len());
    let mut refusals = Vec::new();
    for (field, value) in &row.changes {
        match check_change(field, value) {
            Ok(checked) => changes.push(checked),
            Err(error) => refusals.push(row_refusal(Some(field), error)?),
        }
    }
    Ok(GridRow {
        employee_id: row.employee_id,
        changes,
        refusals,
        expected_updated_at,
    })
}

/// Every employee the request names, in id order, with its values.
pub(super) async fn resolve<'a>(
    tx: &mut Transaction<'_, Postgres>,
    targets: &'a mut Targets,
) -> Result<Vec<RowInput<'a>>, HrError> {
    let (selection, changes) = match targets {
        Targets::Selection { selection, changes } => (selection, changes),
        Targets::Grid(grid) => {
            return Ok(grid
                .iter_mut()
                .map(|row| RowInput {
                    employee_id: row.employee_id,
                    changes: &row.changes,
                    refusals: std::mem::take(&mut row.refusals),
                    expected_updated_at: row.expected_updated_at,
                })
                .collect());
        }
    };
    let filters = filters(selection)?;
    let mut query = filtered_employees("SELECT e.id", &filters);
    query.push(" AND NOT (e.id = ANY(");
    query.push_bind(selection.exclude_ids.clone());
    query.push(")) ORDER BY e.id");
    let ids: Vec<Uuid> = query.build_query_scalar().fetch_all(tx.as_mut()).await?;
    selected_rows(ids, changes)
}

fn selected_rows(ids: Vec<Uuid>, changes: &[CheckedChange]) -> Result<Vec<RowInput<'_>>, HrError> {
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
            changes,
            refusals: Vec::new(),
            expected_updated_at: None,
        })
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selected_rows_share_the_normalized_change() {
        let changes = [check_change("job", &json!(" engineer ")).unwrap()];
        let rows = selected_rows(vec![Uuid::from_u128(1), Uuid::from_u128(2)], &changes).unwrap();
        assert!(
            rows.iter()
                .all(|row| std::ptr::eq(row.changes, &changes[..]))
        );
        assert_eq!(changes[0].value.1.as_deref(), Some("engineer"));
    }

    #[test]
    fn grid_pins_are_checked_before_resolving_employees() {
        let row = |pin: &str| BulkCorrectionRow {
            employee_id: Uuid::nil(),
            changes: Map::from_iter([("job".to_owned(), json!("engineer"))]),
            expected_updated_at: Some(pin.to_owned()),
        };
        let error = check_targets(None, None, vec![row("yesterday")])
            .err()
            .unwrap();
        assert_eq!(error.status, http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            error.message,
            "expected_updated_at must be an RFC 3339 timestamp"
        );
        let checked = grid_row(row("1970-01-01T01:00:00+01:00")).unwrap();
        assert_eq!(
            checked.expected_updated_at,
            Some(OffsetDateTime::UNIX_EPOCH)
        );
    }
}
