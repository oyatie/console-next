// SPDX-License-Identifier: LicenseRef-Proprietary
//! RRN and `id_type` cell extraction and Mod-11 staging for `import/sheet.rs`.

use console_hr_domain::import::grid::{Cell, cell_ref};
use console_hr_domain::import::review::Note;
use console_hr_domain::import::rrn_value::Rrn;
use console_hr_domain::import::sex::sex_of_rrn;
use console_hr_domain::profile::enums::IdType;
use console_hr_domain::profile::identity::{infer_id_type_from_seventh, parse_id_type_import};

use super::sheet::{SheetContext, SheetRows, StagedIdentity};

pub(super) struct ExtractedIdentity {
    pub rrn_sex: Option<String>,
    pub id_type_stored: Option<String>,
    pub inferred_id_type: Option<String>,
    pub rrn_validation_error: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_row_identity(
    ctx: &SheetContext<'_>,
    sheet_name: &str,
    row_index: u32,
    source_row: i32,
    source_key: &str,
    name_present: bool,
    raw_id_type: Option<String>,
    rrn_col_cell: Option<(u32, &Cell)>,
    unavailable: &mut bool,
    out: &mut SheetRows,
) -> ExtractedIdentity {
    let explicit_id_type = raw_id_type.as_deref().and_then(parse_id_type_import);
    let id_type_stored = explicit_id_type
        .map(|t| t.as_str().to_owned())
        .or(raw_id_type);
    let mut rrn_sex = None;
    let mut inferred_id_type = None;
    let mut rrn_validation_error = None;
    let note = |reason: &'static str, at: Option<String>| Note {
        reason,
        blocking: false,
        sheet: sheet_name.to_owned(),
        row: Some(source_row),
        cell: at,
    };

    if name_present && let Some((column, cell)) = rrn_col_cell {
        let parsed = Rrn::parse(&cell.text());
        rrn_sex = parsed
            .as_ref()
            .ok()
            .and_then(|rrn| sex_of_rrn(rrn.digits()))
            .map(str::to_owned);
        match parsed {
            Err(_) => out
                .notes
                .push(note("rrn_invalid", Some(cell_ref(column, row_index)))),
            Ok(rrn) if matches!(rrn.seventh_digit(), 5..=8) && !rrn.passes_mod11() => {
                out.notes
                    .push(note("rrn_mod11_invalid", Some(cell_ref(column, row_index))));
                rrn_validation_error = Some("rrn_mod11_invalid".to_owned());
            }
            Ok(rrn) => {
                inferred_id_type =
                    infer_id_type_from_seventh(rrn.seventh_digit()).map(|t| t.as_str().to_owned());
                let staged_id_type = match explicit_id_type {
                    Some(IdType::DomesticResidence) if matches!(rrn.seventh_digit(), 5..=8) => {
                        Some(IdType::DomesticResidence.as_str().to_owned())
                    }
                    _ => inferred_id_type.clone(),
                };
                match ctx.vault.map(|vault| vault.seal(ctx.org, &rrn)) {
                    Some(Ok(sealed)) => out.identities.push(StagedIdentity {
                        source_key: source_key.to_owned(),
                        sealed,
                        id_type: staged_id_type,
                    }),
                    _ if !*unavailable => {
                        *unavailable = true;
                        out.notes.push(Note {
                            reason: "rrn_unavailable",
                            blocking: false,
                            sheet: sheet_name.to_owned(),
                            row: None,
                            cell: None,
                        });
                    }
                    _ => {}
                }
            }
        }
    }
    ExtractedIdentity {
        rrn_sex,
        id_type_stored,
        inferred_id_type,
        rrn_validation_error,
    }
}
