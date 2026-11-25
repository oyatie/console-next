//! Planning a bulk correction: each employee's record compared with the
//! values to write, every precondition checked, and the preview with its
//! digest. The preview reads without locks; the commit plans again over
//! the rows it has locked and must arrive at the same digest.

use std::collections::BTreeSet;

use console_hr_domain::corrections::bulk::{FieldPath, RowOutcome, field_path};
use console_hr_domain::corrections::route_for_current;
use console_hr_domain::profile::mask::RevealField;
use http::StatusCode;
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::select::RowInput;
use super::{
    BulkCorrectionCounts, BulkCorrectionField, BulkCorrectionPreview, BulkCorrectionPreviewRow,
    BulkCorrectionRefusal, row_refusal,
};
use crate::HrError;
use crate::corrections::{
    FieldValue, LockedEmployee, SecondPersonContext, check_against_record, read_employee, refusal,
};
use crate::digest::json_sha256_hex;

/// One employee's plan: the preview row, and for CHANGE / PENDING the record
/// read and the differing values with their path.
pub(super) struct PlannedRow<'a> {
    pub row: BulkCorrectionPreviewRow,
    record: PlannedWrites<'a>,
}

pub(super) struct PlannedWrites<'a> {
    pub head: Option<LockedEmployee>,
    pub writes: Vec<(&'a FieldValue, FieldPath)>,
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

/// The recorded value as a preview shows it: a field the reveal governs as its mask.
fn shown(head: &LockedEmployee, field: &str) -> Option<String> {
    current(head, field).map(|value| {
        RevealField::from_column(field).map_or_else(|| value.to_owned(), |f| f.masked(value))
    })
}

/// Whether `value` is a write: it differs from the record, or it lands on a
/// value the reveal governs, where dropping it as unchanged would confirm a guess.
fn writes(head: &LockedEmployee, field: &str, value: Option<&str>) -> bool {
    let recorded = current(head, field);
    recorded != value || (recorded.is_some() && RevealField::from_column(field).is_some())
}

/// The record checks of `values`; when they fail, each value is checked on
/// its own so the refusal names its field (EMP-UI 13). A failure no single
/// value causes (dates out of order across two fields) is the row's.
async fn record_refusals(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    head: &LockedEmployee,
    values: &[FieldValue],
) -> Result<Vec<BulkCorrectionRefusal>, HrError> {
    let Err(combined) = check_against_record(tx, org, employee_id, head, values).await else {
        return Ok(Vec::new());
    };
    let combined = row_refusal(None, combined)?;
    let mut refusals = Vec::new();
    for value in values {
        if let Err(error) =
            check_against_record(tx, org, employee_id, head, std::slice::from_ref(value)).await
        {
            refusals.push(row_refusal(Some(&value.0), error)?);
        }
    }
    if refusals.is_empty() {
        refusals.push(combined);
    }
    Ok(refusals)
}

/// The values of `input` that differ from the record, each with its path;
/// `Err` lists every refusal of the row (a field's, or the row's).
async fn plan_row<'a>(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    input: RowInput<'a>,
    holders: SecondPersonContext,
    numbers: &mut BTreeSet<String>,
) -> Result<
    Result<(LockedEmployee, Vec<(&'a FieldValue, FieldPath)>), Vec<BulkCorrectionRefusal>>,
    HrError,
> {
    let head = match read_employee(tx, org, input.employee_id).await {
        Ok(head) => head,
        Err(error) => return Ok(Err(vec![row_refusal(None, error)?])),
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
        return Ok(Err(vec![row_refusal(None, stale)?]));
    }
    let mut refusals = input.refusals;
    let mut checked: Vec<_> = input
        .changes
        .iter()
        .filter(|change| {
            let (field, value) = &change.value;
            writes(&head, field, value.as_deref())
        })
        .collect();
    checked.sort_by(|a, b| a.value.0.cmp(&b.value.0));
    // check_against_record sees the database only: an employee number given
    // twice in one batch is refused here, before the commit could meet it.
    let number = checked
        .iter()
        .find(|change| change.value.0 == "employee_number")
        .and_then(|change| change.value.1.as_ref());
    if number.is_some_and(|number| numbers.contains(number)) {
        let twice = refusal(
            StatusCode::CONFLICT,
            "employee_number_in_use",
            "another row of this bulk correction gives the same employee number",
        );
        refusals.push(row_refusal(Some("employee_number"), twice)?);
    }
    let values: Vec<FieldValue> = checked.iter().map(|change| change.value.clone()).collect();
    refusals.extend(record_refusals(tx, org, input.employee_id, &head, &values).await?);
    let high = holders.path();
    let mut writes = Vec::with_capacity(checked.len());
    for change in checked {
        let pair = &change.value;
        match field_path(
            route_for_current(change.route, head.current(&pair.0).is_some()),
            high,
        ) {
            Some(path) => writes.push((pair, path)),
            None => {
                let sole = refusal(
                    StatusCode::FORBIDDEN,
                    "employee_correction_sole_holder_refused",
                    "no second person can approve this correction and the organization refuses sole-holder corrections",
                );
                refusals.push(row_refusal(Some(&pair.0), sole)?);
            }
        }
    }
    if !refusals.is_empty() {
        return Ok(Err(refusals));
    }
    // Reserved only by a row that passed: a refused row takes no number.
    numbers.extend(number.cloned());
    Ok(Ok((head, writes)))
}

/// Plans every input in order. A client error is the row's refusal; a server
/// fault aborts the whole plan.
pub(super) async fn plan<'a>(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    inputs: Vec<RowInput<'a>>,
    holders: SecondPersonContext,
) -> Result<Vec<PlannedRow<'a>>, HrError> {
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
                        before: shown(&head, field),
                        after: after.clone(),
                        path: path.as_str(),
                    })
                    .collect();
                planned.push(PlannedRow {
                    row,
                    record: PlannedWrites {
                        head: Some(head),
                        writes,
                    },
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
                    record: PlannedWrites {
                        head: None,
                        writes: Vec::new(),
                    },
                });
            }
        }
    }
    Ok(planned)
}

pub(super) struct CorrectionPlan<'a> {
    pub preview: BulkCorrectionPreview,
    pub records: Vec<PlannedWrites<'a>>,
}

/// Move the planned rows into the preview and retain the writes for commit.
pub(super) fn preview<'a>(
    planned: Vec<PlannedRow<'a>>,
    reason_code: &str,
    note: Option<&str>,
) -> Result<CorrectionPlan<'a>, HrError> {
    let (rows, records): (Vec<_>, Vec<_>) = planned.into_iter().map(|p| (p.row, p.record)).unzip();
    let mut counts = BulkCorrectionCounts {
        selected: rows.len(),
        ..BulkCorrectionCounts::default()
    };
    for row in &rows {
        match row.outcome {
            "CHANGE" => counts.change += 1,
            "PENDING" => counts.pending += 1,
            "UNCHANGED" => counts.unchanged += 1,
            _ => counts.refused += 1,
        }
    }
    // Field order preserves the digest of previews already issued.
    #[derive(Serialize)]
    struct CanonicalPreview<'a> {
        reason_code: &'a str,
        note: Option<&'a str>,
        rows: &'a [BulkCorrectionPreviewRow],
    }
    let digest = json_sha256_hex(&CanonicalPreview {
        reason_code,
        note,
        rows: &rows,
    })
    .map_err(|error| HrError::internal(format!("cannot serialize correction preview: {error}")))?;
    let preview_id = Uuid::parse_str(&digest[..32])
        .map_err(|_| HrError::internal("preview digest is not hex"))?;
    let step_up_required = records.iter().any(|p| {
        p.writes
            .iter()
            .any(|(_, path)| *path == FieldPath::SoleHolderReview)
    });
    Ok(CorrectionPlan {
        preview: BulkCorrectionPreview {
            preview_id,
            preview_digest: digest,
            counts,
            step_up_required,
            rows,
        },
        records,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn changed_row(after: String) -> BulkCorrectionPreviewRow {
        BulkCorrectionPreviewRow {
            employee_id: Uuid::nil(),
            name: None,
            employee_number: None,
            updated_at: None,
            outcome: "CHANGE",
            fields: vec![BulkCorrectionField {
                field: "careers".into(),
                before: None,
                after: Some(after),
                path: "NOW",
            }],
            code: None,
            message: None,
            refusals: vec![],
        }
    }

    #[test]
    fn preview_moves_the_planned_value_and_preserves_its_digest() {
        let row = changed_row("employment history".into());
        let after = row.fields[0].after.as_ref().unwrap().as_ptr();
        let reason = "DATA_ENTRY_ERROR";
        let note = Some("correction");
        let canonical = serde_json::json!({ "reason_code": reason, "note": note, "rows": [&row] });
        let expected = crate::digest::sha256_hex(canonical.to_string().as_bytes());
        let planned = vec![PlannedRow {
            row,
            record: PlannedWrites {
                head: None,
                writes: vec![],
            },
        }];
        let result = preview(planned, reason, note).unwrap().preview;
        assert_eq!(result.preview_digest, expected);
        assert_eq!(
            result.rows[0].fields[0].after.as_ref().unwrap().as_ptr(),
            after
        );
    }

    #[test]
    fn a_recorded_pay_compares_as_whole_won() {
        assert_eq!(stored_form("base_pay", Some("3000000.00")), Some("3000000"));
        assert_eq!(stored_form("base_pay", Some("0.00")), Some("0"));
        assert_eq!(stored_form("job", Some("1.00")), Some("1.00"));
        assert_eq!(stored_form("base_pay", None), None);
    }
}
