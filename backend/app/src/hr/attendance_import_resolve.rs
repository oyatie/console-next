// SPDX-License-Identifier: LicenseRef-Proprietary
//! Set-based resolution and deduplication for attendance import dry-run and apply.
use std::collections::{BTreeSet, HashMap};

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::import::parsed::ImportRowStatus;
use console_hr_adapter_postgres::import::types::DataImportRunRecord;
use sqlx::Postgres;
use uuid::Uuid;

use super::attendance_import_batch::{
    load_branches_by_name, load_employees_by_name, load_employees_by_number,
};
use super::{
    AttendanceBranchResolution, AttendanceEmployeeResolution, AttendanceImportDryRunSummary,
    AttendanceImportRowError, ResolvedAttendanceImportRow, StoredAttendanceImportRow,
    attendance_fact_key, attendance_row_error,
};

enum LookupResult<T> {
    Matched(T),
    Missing,
    Ambiguous,
}

enum PassOneOutcome {
    Ready {
        row_index: usize,
        resolved: Box<ResolvedAttendanceImportRow>,
    },
    Failed {
        duplicate: bool,
        missing_employee: bool,
        ambiguous_employee: bool,
        errors: Vec<AttendanceImportRowError>,
    },
}

pub(super) async fn resolve_attendance_import_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    run: &DataImportRunRecord,
    rows: &[StoredAttendanceImportRow],
) -> Result<AttendanceImportDryRunSummary, HrError> {
    let source_keys: Vec<String> = rows.iter().map(|row| row.source_key.clone()).collect();
    let existing_keys = if source_keys.is_empty() {
        BTreeSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT source_key
            FROM attendance_direct_import_events
            WHERE org_id = $1 AND source_sha256 = $2 AND source_key = ANY($3)
            "#,
        )
        .bind(org_uuid)
        .bind(&run.source_sha256)
        .bind(&source_keys)
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .collect::<BTreeSet<_>>()
    };

    let mut emp_numbers = BTreeSet::new();
    let mut emp_names = BTreeSet::new();
    let mut branch_names = BTreeSet::new();
    for row in rows {
        if row.row_status == ImportRowStatus::Candidate && !existing_keys.contains(&row.source_key)
        {
            if let Some(num) = row.canonical.employee_number.as_deref() {
                emp_numbers.insert(num.to_owned());
            } else if let Some(name) = row.canonical.employee_name.as_deref() {
                emp_names.insert(name.to_owned());
            }
            if let Some(branch) = row.canonical.branch_name.as_deref() {
                branch_names.insert(branch.to_owned());
            }
        }
    }

    let employees_by_number = load_employees_by_number(tx, org_uuid, emp_numbers).await?;
    let employees_by_name = load_employees_by_name(tx, org_uuid, emp_names).await?;
    let branches_by_name = load_branches_by_name(tx, org_uuid, branch_names).await?;

    let mut resolved_fact_keys = BTreeSet::<String>::new();
    let mut outcomes = Vec::with_capacity(rows.len());
    let mut candidate_fact_keys = Vec::new();

    for (row_index, row) in rows.iter().enumerate() {
        if row.row_status != ImportRowStatus::Candidate {
            let errors = if row.validation_errors.is_empty() {
                vec![attendance_row_error(
                    row,
                    "invalid_row",
                    "attendance import row is not a candidate",
                )]
            } else {
                row.validation_errors
                    .iter()
                    .map(|code| attendance_row_error(row, code, code))
                    .collect()
            };
            outcomes.push(PassOneOutcome::Failed {
                duplicate: false,
                missing_employee: false,
                ambiguous_employee: false,
                errors,
            });
            continue;
        }
        if existing_keys.contains(&row.source_key) {
            outcomes.push(PassOneOutcome::Failed {
                duplicate: true,
                missing_employee: false,
                ambiguous_employee: false,
                errors: vec![attendance_row_error(
                    row,
                    "duplicate_import_row",
                    "attendance import row source key was already applied",
                )],
            });
            continue;
        }
        let employee = match lookup_employee(row, &employees_by_number, &employees_by_name) {
            LookupResult::Matched(employee) => employee,
            LookupResult::Missing => {
                outcomes.push(PassOneOutcome::Failed {
                    duplicate: false,
                    missing_employee: true,
                    ambiguous_employee: false,
                    errors: vec![attendance_row_error(
                        row,
                        "missing_employee",
                        "no employee matched the attendance row identifier",
                    )],
                });
                continue;
            }
            LookupResult::Ambiguous => {
                outcomes.push(PassOneOutcome::Failed {
                    duplicate: false,
                    missing_employee: false,
                    ambiguous_employee: true,
                    errors: vec![attendance_row_error(
                        row,
                        "ambiguous_employee",
                        "attendance row identifier matched multiple employees",
                    )],
                });
                continue;
            }
        };
        let branch = match lookup_branch(row, &branches_by_name) {
            LookupResult::Matched(branch) => branch,
            LookupResult::Missing => {
                outcomes.push(PassOneOutcome::Failed {
                    duplicate: false,
                    missing_employee: false,
                    ambiguous_employee: false,
                    errors: vec![attendance_row_error(
                        row,
                        "missing_branch",
                        "no branch matched the attendance row branch name",
                    )],
                });
                continue;
            }
            LookupResult::Ambiguous => {
                outcomes.push(PassOneOutcome::Failed {
                    duplicate: false,
                    missing_employee: false,
                    ambiguous_employee: false,
                    errors: vec![attendance_row_error(
                        row,
                        "ambiguous_branch",
                        "attendance row branch name matched multiple branches",
                    )],
                });
                continue;
            }
        };
        let employee_number = row
            .canonical
            .employee_number
            .clone()
            .or_else(|| employee.employee_number.clone());
        let Some(work_date) = row.canonical.work_date.clone() else {
            outcomes.push(PassOneOutcome::Failed {
                duplicate: false,
                missing_employee: false,
                ambiguous_employee: false,
                errors: vec![attendance_row_error(
                    row,
                    "missing_work_date",
                    "work_date is required",
                )],
            });
            continue;
        };
        let fact_key = attendance_fact_key(
            employee.id,
            branch.id,
            &work_date,
            row.canonical.check_in_at.as_deref(),
            row.canonical.check_out_at.as_deref(),
            row.canonical.minutes_worked,
        );
        if !resolved_fact_keys.insert(fact_key.clone()) {
            outcomes.push(PassOneOutcome::Failed {
                duplicate: true,
                missing_employee: false,
                ambiguous_employee: false,
                errors: vec![attendance_row_error(
                    row,
                    "duplicate_attendance_fact_in_file",
                    "attendance fact is duplicated within this import run",
                )],
            });
            continue;
        }
        candidate_fact_keys.push(fact_key.clone());
        outcomes.push(PassOneOutcome::Ready {
            row_index,
            resolved: Box::new(ResolvedAttendanceImportRow {
                import_row_id: row.import_row_id,
                employee_id: employee.id,
                branch_id: branch.id,
                source_sheet: row.source_sheet.clone(),
                source_row: row.source_row,
                source_key: row.source_key.clone(),
                employee_number,
                employee_name: employee.name.clone(),
                branch_name: branch.name.clone(),
                work_date,
                check_in_at: row.canonical.check_in_at.clone(),
                check_out_at: row.canonical.check_out_at.clone(),
                minutes_worked: row.canonical.minutes_worked,
                fact_key,
            }),
        });
    }

    let existing_fact_keys: BTreeSet<String> = if candidate_fact_keys.is_empty() {
        BTreeSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT fact_key
            FROM attendance_direct_import_events
            WHERE org_id = $1 AND fact_key = ANY($2)
            "#,
        )
        .bind(org_uuid)
        .bind(&candidate_fact_keys)
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .collect()
    };

    let mut summary = AttendanceImportDryRunSummary {
        run_id,
        input_rows: usize::try_from(run.input_rows).unwrap_or_default(),
        candidate_rows: usize::try_from(run.candidate_rows).unwrap_or_default(),
        preserved_rows: usize::try_from(run.preserved_rows).unwrap_or_default(),
        ..AttendanceImportDryRunSummary::default()
    };

    for outcome in outcomes {
        match outcome {
            PassOneOutcome::Failed {
                duplicate,
                missing_employee,
                ambiguous_employee,
                errors,
            } => {
                summary.error_rows += 1;
                if duplicate {
                    summary.duplicate_rows += 1;
                }
                if missing_employee {
                    summary.missing_employee_rows += 1;
                }
                if ambiguous_employee {
                    summary.ambiguous_employee_rows += 1;
                }
                summary.row_errors.extend(errors);
            }
            PassOneOutcome::Ready {
                row_index,
                resolved,
            } => {
                if existing_fact_keys.contains(&resolved.fact_key) {
                    summary.error_rows += 1;
                    summary.duplicate_rows += 1;
                    summary.row_errors.push(attendance_row_error(
                        &rows[row_index],
                        "duplicate_attendance_fact",
                        "attendance fact was already imported",
                    ));
                } else {
                    summary.ready_rows_for_apply.push(*resolved);
                }
            }
        }
    }

    summary.ready_rows = summary.ready_rows_for_apply.len();
    Ok(summary)
}

fn lookup_employee<'a>(
    row: &StoredAttendanceImportRow,
    by_number: &'a HashMap<String, Vec<AttendanceEmployeeResolution>>,
    by_name: &'a HashMap<String, Vec<AttendanceEmployeeResolution>>,
) -> LookupResult<&'a AttendanceEmployeeResolution> {
    let matches = if let Some(num) = row.canonical.employee_number.as_deref() {
        by_number.get(num)
    } else if let Some(name) = row.canonical.employee_name.as_deref() {
        by_name.get(name)
    } else {
        return LookupResult::Missing;
    };
    match matches.map(Vec::as_slice) {
        Some([one]) => LookupResult::Matched(one),
        Some(many) if many.len() > 1 => LookupResult::Ambiguous,
        _ => LookupResult::Missing,
    }
}

fn lookup_branch<'a>(
    row: &StoredAttendanceImportRow,
    by_name: &'a HashMap<String, Vec<AttendanceBranchResolution>>,
) -> LookupResult<&'a AttendanceBranchResolution> {
    let Some(branch_name) = row.canonical.branch_name.as_deref() else {
        return LookupResult::Missing;
    };
    match by_name.get(branch_name).map(Vec::as_slice) {
        Some([one]) => LookupResult::Matched(one),
        Some(many) if many.len() > 1 => LookupResult::Ambiguous,
        _ => LookupResult::Missing,
    }
}
