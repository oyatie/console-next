//! `POST /employees/import/preview`: stage the parsed workbook as a
//! PREVIEWED run and return the masked preview (moved from `app/src/hr.rs`,
//! R2-import). The multipart upload and the calamine parse stay in the shell.

use console_platform_authz::Principal;
use console_platform_db::with_audit;
use serde_json::json;
use uuid::Uuid;

use crate::directory::access_log::import_rows_event;
use console_hr_domain::import::review::Note;
use serde_json::Value;

use crate::import::canonical::{import_canonical_row_json, import_validation_json};
use crate::import::identities;
use crate::import::mask::employee_import_mapping_profile;
use crate::import::memory::remember_columns;
use crate::import::parsed::ParsedEmployeeImportWorkbook;
use crate::import::types::{EmployeeImportPreviewResponse, XlsxUpload};
use crate::{HrError, HrService};

impl HrService {
    pub async fn preview_import(
        &self,
        principal: Principal,
        upload: XlsxUpload,
        source_sha256: String,
        parsed: ParsedEmployeeImportWorkbook,
    ) -> Result<EmployeeImportPreviewResponse, HrError> {
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let actor = principal.user_id;
        let run_id = Uuid::new_v4();
        let mut mapping_profile = employee_import_mapping_profile(&parsed.columns);
        mapping_profile["sheets"] = json!(parsed.sheets);
        mapping_profile["notes"] = notes_json(&parsed.notes);
        let input_rows = i32::try_from(parsed.input_rows())
            .map_err(|_| HrError::validation("import row count exceeds i32"))?;
        let candidate_rows = i32::try_from(parsed.candidate_rows())
            .map_err(|_| HrError::validation("candidate row count exceeds i32"))?;
        let preserved_rows = i32::try_from(parsed.preserved_rows())
            .map_err(|_| HrError::validation("preserved row count exceeds i32"))?;
        let audit_after = json!({
            "run_id": run_id,
            "entity_type": "employee_hr",
            "source_filename": &upload.filename,
            "source_sha256": &source_sha256,
            "input_rows": input_rows,
            "candidate_rows": candidate_rows,
            "preserved_rows": preserved_rows,
            "sealed_identities": parsed.identities.len(),
            "sensitive_values_returned": false
        });
        let event = import_rows_event(&principal, "data_import.preview", run_id, audit_after)?;

        let shown = parsed.shown.clone();
        let needing = parsed
            .notes
            .iter()
            .filter(|note| note.reason == "sheet_needs_mapping")
            .count();
        let sealed = parsed.identities.len();
        let preview = with_audit::<_, _, HrError>(&self.pool, event, |tx| {
            let identities = parsed.identities.clone();
            let phones = parsed.phones.clone();
            let remembered = parsed.remembered.clone();
            let rows = parsed.rows.clone();
            let columns = parsed.columns.clone();
            let filename = upload.filename.clone();
            let pay_period_start = upload.pay_period_start;
            let pay_period_end = upload.pay_period_end;
            let source_sha256 = source_sha256.clone();
            let mapping_profile = mapping_profile.clone();
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO data_import_runs (
                        id, org_id, entity_type, status, source_filename, source_format,
                        source_sha256, mapping_profile, input_rows, candidate_rows,
                        preserved_rows, created_by, pay_period_start, pay_period_end
                    )
                    VALUES ($1, $2, 'employee_hr', 'PREVIEWED', $3, 'xlsx', $4, $5, $6, $7, $8, $9, $10, $11)
                    "#,
                )
                .bind(run_id)
                .bind(org_uuid)
                .bind(&filename)
                .bind(&source_sha256)
                .bind(&mapping_profile)
                .bind(input_rows)
                .bind(candidate_rows)
                .bind(preserved_rows)
                .bind(*actor.as_uuid())
                .bind(pay_period_start)
                .bind(pay_period_end)
                .execute(tx.as_mut())
                .await?;

                for row in &rows {
                    sqlx::query(
                        r#"
                        INSERT INTO data_import_rows (
                            org_id, run_id, source_sheet, source_row, source_key,
                            row_status, raw_row, canonical_row, validation
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(run_id)
                    .bind(&row.source_sheet)
                    .bind(row.source_row)
                    .bind(&row.source_key)
                    .bind(row.row_status.as_str())
                    .bind(&row.raw_row)
                    .bind(import_canonical_row_json(row))
                    .bind(import_validation_json(row))
                    .execute(tx.as_mut())
                    .await?;
                }

                identities::purge_expired(tx, org_uuid).await?;
                identities::stage(tx, org_uuid, run_id, &identities).await?;
                crate::import::phones::stage(tx, org_uuid, run_id, &phones).await?;
                remember_columns(tx, org_uuid, *actor.as_uuid(), &remembered).await?;

                Ok(EmployeeImportPreviewResponse::from_rows(
                    run_id,
                    filename,
                    source_sha256,
                    columns,
                    rows,
                ))
            })
        })
        .await?;

        metrics::counter!("hr_data_import_runs_total", "stage" => "preview").increment(1);
        Ok(EmployeeImportPreviewResponse {
            sheets: shown,
            sheets_needing_mapping: needing,
            sealed_identities: sealed,
            ..preview
        })
    }
}

/// The parse's 확인 필요 notes as stored with the run.
pub fn notes_json(notes: &[Note]) -> Value {
    json!(
        notes
            .iter()
            .map(|n| json!({
                "reason": n.reason, "blocking": n.blocking, "sheet": n.sheet,
                "row": n.row, "cell": n.cell,
            }))
            .collect::<Vec<_>>()
    )
}

/// The stored notes back (unknown reasons are skipped).
pub fn notes_from(profile: &Value) -> Vec<Note> {
    const KNOWN: [&str; 5] = [
        "sheet_needs_mapping",
        "rrn_unavailable",
        "rrn_invalid",
        // W12: non-blocking notes of the parse.
        "summary_row_skipped",
        "phone_invalid",
    ];
    profile["notes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| {
            let reason = KNOWN
                .into_iter()
                .find(|k| Some(*k) == n["reason"].as_str())?;
            Some(Note {
                reason,
                blocking: n["blocking"].as_bool().unwrap_or(true),
                sheet: n["sheet"].as_str()?.to_owned(),
                row: n["row"].as_i64().and_then(|r| i32::try_from(r).ok()),
                cell: n["cell"].as_str().map(ToOwned::to_owned),
            })
        })
        .collect()
}
