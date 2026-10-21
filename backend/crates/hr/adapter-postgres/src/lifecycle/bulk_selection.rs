//! Who a bulk appointment names (hr-polish A4, A5; data-display-and-realtime
//! §6.1 bulk selection): an explicit id list, per-line destination units
//! (a pasted TRANSFER sheet across units, still one all-or-nothing batch), or
//! 「필터와 일치하는 {n}명 모두 선택」 — a server-side selection by the list
//! filters minus exclusions, checked against the count the user confirmed.

use std::collections::BTreeSet;

use console_kernel_core::BranchScope;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::requests::MAX_BULK_EMPLOYEES;
use crate::HrError;
use crate::directory::read_filters::{EmployeeListFilters, EmployeeListQuery, counted_employees};

/// The most employees one selection by query may name.
// a fixed technical bound — every employee is locked, validated and
// recorded in one transaction under `transaction_timeout`; move the batch to a
// job (LRO-1) before raising it.
pub const MAX_BULK_SELECTION: usize = 3_000;

/// One line of a per-line TRANSFER: this employee moves to this unit.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BulkTransferLine {
    pub employee_id: Uuid,
    pub to_org_unit_id: Uuid,
}

/// Every employee the list filters admit, minus the excluded ones.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BulkSelection {
    /// The `GET /employees` filters (paging fields are ignored).
    pub query: EmployeeListQuery,
    #[serde(default)]
    pub exclude_employee_ids: Vec<Uuid>,
    /// The count the confirmation showed; a different resolved count is 409.
    pub expected_count: usize,
}

/// Exactly one of `employee_ids`, `lines` or `selection`, within its cap and
/// without repeats (`lines` vs the batch unit is checked by the caller).
pub fn validate_bulk_targets(
    employee_ids: &[Uuid],
    lines: &[BulkTransferLine],
    selection: Option<&BulkSelection>,
) -> Result<(), HrError> {
    let repeats =
        |ids: &mut dyn Iterator<Item = Uuid>, len: usize| ids.collect::<BTreeSet<_>>().len() != len;
    match (employee_ids.is_empty(), lines.is_empty(), selection) {
        (true, true, None) => Err(HrError::validation(
            "employee_ids must list 1 to 500 employees",
        )),
        (false, true, None) => {
            if employee_ids.len() > MAX_BULK_EMPLOYEES {
                return Err(HrError::validation(
                    "employee_ids must list 1 to 500 employees",
                ));
            }
            if repeats(&mut employee_ids.iter().copied(), employee_ids.len()) {
                return Err(HrError::validation(
                    "employee_ids must not repeat an employee",
                ));
            }
            Ok(())
        }
        (true, false, None) => {
            if lines.len() > MAX_BULK_EMPLOYEES {
                return Err(HrError::validation("lines must list 1 to 500 employees"));
            }
            if repeats(&mut lines.iter().map(|line| line.employee_id), lines.len()) {
                return Err(HrError::validation("lines must not repeat an employee"));
            }
            Ok(())
        }
        (true, true, Some(selection)) => {
            if selection.expected_count == 0 || selection.expected_count > MAX_BULK_SELECTION {
                return Err(HrError::validation(format!(
                    "a selection must name 1 to {MAX_BULK_SELECTION} employees"
                )));
            }
            Ok(())
        }
        _ => Err(HrError::validation(
            "name the employees with exactly one of employee_ids, lines or selection",
        )),
    }
}

/// 409 `bulk_selection_changed`: the filters now admit a different number of
/// employees than the confirmation showed; nothing was recorded.
pub fn bulk_selection_changed(expected: usize, found: usize) -> HrError {
    HrError {
        status: StatusCode::CONFLICT,
        code: "bulk_selection_changed",
        message: format!(
            "the selection now matches {found} employees, not the {expected} confirmed; nothing was recorded"
        ),
        refusals: None,
    }
}

/// The selection's employee ids in id order, read in the batch transaction
/// under the caller's branch scope.
pub async fn resolve_selection(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    selection: &BulkSelection,
    scope: &BranchScope,
) -> Result<Vec<Uuid>, HrError> {
    let filters = EmployeeListFilters::from_query(&selection.query, scope)?;
    let mut query = counted_employees("SELECT e.id", &filters);
    if !selection.exclude_employee_ids.is_empty() {
        query.push(" AND NOT (e.id = ANY(");
        query.push_bind(selection.exclude_employee_ids.clone());
        query.push("))");
    }
    query.push(" ORDER BY e.id");
    let ids: Vec<Uuid> = query.build_query_scalar().fetch_all(tx.as_mut()).await?;
    if ids.len() == selection.expected_count {
        Ok(ids)
    } else {
        Err(bulk_selection_changed(selection.expected_count, ids.len()))
    }
}
