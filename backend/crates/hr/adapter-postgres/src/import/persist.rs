//! The one path from a spreadsheet row to persistable JSON (restricted and RRN cells dropped).
//! Moved from `app/src/hr.rs` (R2-import).

use console_hr_domain::import::rrn::is_rrn_value;
use serde_json::{Map, Value};

use crate::import::canonical::json_value_text;

/// The only way a spreadsheet row becomes persistable JSON. A restricted
/// column's cell and any cell holding a 주민등록번호-shaped value are dropped
/// here, before the row reaches `data_import_rows`, `employees` or a preview;
/// only the header names of non-empty dropped cells are returned, so the
/// mapping profile can still say the column was present.
pub fn persistable_import_row(
    normalized_headers: &[String],
    cell: impl Fn(usize) -> Value,
    restricted_header: impl Fn(&str) -> bool,
) -> (Value, Vec<String>) {
    let mut raw = Map::new();
    let mut dropped = Vec::new();
    for (idx, header) in normalized_headers.iter().enumerate() {
        if header.is_empty() {
            continue;
        }
        let value = cell(idx);
        let text = json_value_text(&value);
        if restricted_header(header) || text.as_deref().is_some_and(is_rrn_value) {
            if text.is_some() {
                dropped.push(header.clone());
            }
            continue;
        }
        raw.insert(header.clone(), value);
    }
    (Value::Object(raw), dropped)
}
