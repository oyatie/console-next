//! Planning a bulk correction: each employee's record compared with the
//! values to write, every precondition checked, and the preview with its
//! digest. The preview reads without locks; the commit plans again over
//! the rows it has locked and must arrive at the same digest.

use std::collections::BTreeSet;

use console_hr_domain::corrections::bulk::{FieldPath, RowOutcome, field_path};
use console_hr_domain::corrections::route_for_current;
use http::StatusCode;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::select::RowInput;
use super::{
    BulkCorrectionCounts, BulkCorrectionField, BulkCorrectionPreview, BulkCorrectionPreviewRow,
    BulkCorrectionRefusal,
};
use crate::HrError;
use crate::corrections::{
    FieldValue, LockedEmployee, SecondPersonContext, check_against_record, normalize_value,
    read_employee, refusal, route_or_refuse,
};
use crate::digest::sha256_hex;

/// One employee's plan: the preview row, and for CHANGE / PENDING the record
/// read and the differing values with their path.
pub(super) struct PlannedRow {
    pub row: BulkCorrectionPreviewRow,
    pub head: Option<LockedEmployee>,
    pub writes: Vec<(FieldValue, FieldPath)>,
}

/// The recorded value of `field` in the form `normalize_value` gives: the
/// legacy `base_pay` column is NUMERIC(14,2) ("3000000.00") while a
/// correction carries whole won ("3000000").
fn stored_form<'a>(field: &str, value: Option<&'a str>) -> Option<&'a str> {
    match (field, value) {
        ("base_pay", Some(won)) => Some(won.strip_suffix(".00").unwrap_or(won)),
        (_, value) => value,
    }
}

fn current<'a>(head: &'a LockedEmployee, field: &str) -> Option<&'a str> {
    stored_form(field, head.current(field))
}

/// One refusal of a row: the field it is about (`None`: the whole row).
fn refused_by(field: Option<&str>, error: &HrError) -> BulkCorrectionRefusal {
    BulkCorrectionRefusal {
        field: field.map(str::to_owned),
        code: error.code,
        message: error.message.clone(),
    }
}

/// A client error is the row's (or one field's) refusal; a server fault
/// aborts the whole plan.
fn client(error: HrError) -> Result<HrError, HrError> {
    if error.status.is_client_error() {
        Ok(error)
    } else {
        Err(error)
    }
}

/// The record checks of `values`; when they fail, each value is checked on
/// its own so the refusal names its field (EMP-UI 13). A failure no single
/// value causes (dates out of order across two fields) is the row's.
async fn record_refusals(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    input: &RowInput,
    head: &LockedEmployee,
    values: &[FieldValue],
) -> Result<Vec<BulkCorrectionRefusal>, HrError> {
    let Err(combined) = check_against_record(tx, org, input.employee_id, head, values).await else {
        return Ok(Vec::new());
    };
    let combined = client(combined)?;
    let mut refusals = Vec::new();
    for value in values {
        if let Err(error) = check_against_record(
            tx,
            org,
            input.employee_id,
            head,
            std::slice::from_ref(value),
        )
        .await
        {
            refusals.push(refused_by(Some(&value.0), &client(error)?));
        }
    }
    if refusals.is_empty() {
        refusals.push(refused_by(None, &combined));
    }
    Ok(refusals)
}

/// The values of `input` that differ from the record, each with its path;
/// `Err` lists every refusal of the row (a field's, or the row's).
async fn plan_row(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    input: &RowInput,
    holders: SecondPersonContext,
    numbers: &mut BTreeSet<String>,
) -> Result<
    Result<(LockedEmployee, Vec<(FieldValue, FieldPath)>), Vec<BulkCorrectionRefusal>>,
    HrError,
> {
    let mut refusals = Vec::new();
    let mut checked = Vec::with_capacity(input.changes.len());
    for (field, value) in &input.changes {
        match route_or_refuse(field).and_then(|route| Ok((normalize_value(field, value)?, route))) {
            Ok((value, route)) => checked.push(((field.clone(), value), route)),
            Err(error) => refusals.push(refused_by(Some(field), &client(error)?)),
        }
    }
    let head = match read_employee(tx, org, input.employee_id).await {
        Ok(head) => head,
        Err(error) => return Ok(Err(vec![refused_by(None, &client(error)?)])),
    };
    if input
        .expected_updated_at
        .is_some_and(|pin| pin != head.updated_at)
    {
        let stale = refusal(
            StatusCode::CONFLICT,
            "stale_record",
            "the employee changed since the grid read it; reload the row",
        );
        return Ok(Err(vec![refused_by(None, &stale)]));
    }
    checked.retain(|((field, value), _)| current(&head, field) != value.as_deref());
    checked.sort_by(|a, b| a.0.0.cmp(&b.0.0));
    // check_against_record sees the database only: a 사번 given twice in one
    // batch is refused here, before the commit could meet it.
    let number = checked
        .iter()
        .find_map(|((field, value), _)| (field == "employee_number").then(|| value.clone()))
        .flatten();
    if number
        .as_ref()
        .is_some_and(|number| numbers.contains(number))
    {
        let twice = refusal(
            StatusCode::CONFLICT,
            "employee_number_in_use",
            "another row of this bulk correction gives the same employee number",
        );
        refusals.push(refused_by(Some("employee_number"), &twice));
    }
    let values: Vec<FieldValue> = checked.iter().map(|(pair, _)| pair.clone()).collect();
    refusals.extend(record_refusals(tx, org, input, &head, &values).await?);
    let high = holders.path();
    let mut writes = Vec::with_capacity(checked.len());
    for (pair, route) in checked {
        match field_path(
            route_for_current(route, head.current(&pair.0).is_some()),
            high,
        ) {
            Some(path) => writes.push((pair, path)),
            None => {
                let sole = refusal(
                    StatusCode::FORBIDDEN,
                    "employee_correction_sole_holder_refused",
                    "no second person can approve this correction and the organization refuses sole-holder corrections",
                );
                refusals.push(refused_by(Some(&pair.0), &sole));
            }
        }
    }
    if !refusals.is_empty() {
        return Ok(Err(refusals));
    }
    // Reserved only by a row that passed: a refused row takes no number.
    numbers.extend(number);
    Ok(Ok((head, writes)))
}

/// Plans every input in order. A client error is the row's refusal; a server
/// fault aborts the whole plan.
pub(super) async fn plan(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    inputs: &[RowInput],
    holders: SecondPersonContext,
) -> Result<Vec<PlannedRow>, HrError> {
    let mut numbers = BTreeSet::new();
    let mut planned = Vec::with_capacity(inputs.len());
    for input in inputs {
        let mut row = BulkCorrectionPreviewRow {
            employee_id: input.employee_id,
            name: None,
            employee_number: None,
            updated_at: None,
            outcome: RowOutcome::Refused.as_str(),
            fields: Vec::new(),
            code: None,
            message: None,
            refusals: Vec::new(),
        };
        match plan_row(tx, org, input, holders, &mut numbers).await? {
            Ok((head, writes)) => {
                row.name = Some(head.name.clone());
                row.employee_number = head.employee_number.clone();
                row.updated_at = Some(head.updated_at);
                let paths: Vec<FieldPath> = writes.iter().map(|(_, path)| *path).collect();
                row.outcome = RowOutcome::of(&paths).as_str();
                row.fields = writes
                    .iter()
                    .map(|((field, after), path)| BulkCorrectionField {
                        field: field.clone(),
                        before: current(&head, field).map(str::to_owned),
                        after: after.clone(),
                        path: path.as_str(),
                    })
                    .collect();
                planned.push(PlannedRow {
                    row,
                    head: Some(head),
                    writes,
                });
            }
            Err(refusals) => {
                // The first refusal stays on the row (compatibility); every
                // one is listed with its field.
                row.code = refusals.first().map(|r| r.code);
                row.message = refusals.first().map(|r| r.message.clone());
                row.refusals = refusals;
                planned.push(PlannedRow {
                    row,
                    head: None,
                    writes: Vec::new(),
                });
            }
        }
    }
    Ok(planned)
}

/// The preview of `planned`: exact counts, the digest that binds the commit
/// (every row's pin, outcome and values, plus the reason), and its job id.
pub(super) fn preview(
    planned: &[PlannedRow],
    reason_code: &str,
    note: Option<&str>,
) -> Result<BulkCorrectionPreview, HrError> {
    let mut counts = BulkCorrectionCounts {
        selected: planned.len(),
        ..BulkCorrectionCounts::default()
    };
    for planned in planned {
        match planned.row.outcome {
            "CHANGE" => counts.change += 1,
            "PENDING" => counts.pending += 1,
            "UNCHANGED" => counts.unchanged += 1,
            _ => counts.refused += 1,
        }
    }
    let rows: Vec<BulkCorrectionPreviewRow> = planned.iter().map(|p| p.row.clone()).collect();
    let canonical = json!({ "reason_code": reason_code, "note": note, "rows": &rows });
    let digest = sha256_hex(canonical.to_string().as_bytes());
    let preview_id = Uuid::parse_str(&digest[..32])
        .map_err(|_| HrError::internal("preview digest is not hex"))?;
    let step_up_required = planned.iter().any(|p| {
        p.writes
            .iter()
            .any(|(_, path)| *path == FieldPath::SoleHolderReview)
    });
    Ok(BulkCorrectionPreview {
        preview_id,
        preview_digest: digest,
        counts,
        step_up_required,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::stored_form;

    #[test]
    fn a_recorded_pay_compares_as_whole_won() {
        assert_eq!(stored_form("base_pay", Some("3000000.00")), Some("3000000"));
        assert_eq!(stored_form("base_pay", Some("0.00")), Some("0"));
        assert_eq!(stored_form("job", Some("1.00")), Some("1.00"));
        assert_eq!(stored_form("base_pay", None), None);
    }
}
