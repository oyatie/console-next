//! One spreadsheet cell's text through every import normaliser: dates, 사번,
//! codes, header labels, RRN detection and the RRN value object (the input of
//! the keyed hash). Invariants: never panic; what `Rrn::parse` accepts the PII
//! scrub (`is_rrn_value`) catches too; the mask and `Debug` never show
//! the back six digits; a column letter round-trips.
#![no_main]

use console_hr_domain::import::rrn_value::Rrn;
use console_hr_domain::import::{cells, classification, grid, normalize, pii, rrn};
use console_hr_domain::text::parse_yyyy_mm_dd;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return;
    };
    let _ = cells::parse_import_date(text);
    let _ = cells::name_key(text);
    let _ = parse_yyyy_mm_dd(text);
    let _ = normalize::employee_number(text);
    let _ = normalize::status_code(text);
    let _ = normalize::leave_type_code(text);
    let header = classification::normalize_header_label(text);
    let _ = classification::import_header_match_key(text);
    let target = classification::employee_import_target_for_header(text);
    let _ = classification::employee_import_column_classification(text, target);
    let _ = classification::is_restricted_employee_import_header(&header);
    let _ = pii::is_pii2_restricted_header(&header);
    let _ = pii::is_stripped_zero_rrn(text);
    let _ = rrn::contains_rrn_shaped(text);
    let scrubbed = rrn::is_rrn_value(text);
    if let Ok(value) = Rrn::parse(text) {
        // A cell the vault would seal as an RRN is one the PII scrub catches too.
        assert!(
            scrubbed,
            "Rrn::parse accepts {text:?} but is_rrn_value misses it"
        );
        let digits = value.digits().to_owned();
        assert_eq!(digits.len(), 13, "{text:?}");
        assert_eq!(
            value.masked(),
            format!("{}-{}******", &digits[..6], &digits[6..7])
        );
        assert!(
            !format!("{value:?}").contains(&digits),
            "Debug prints the RRN"
        );
        assert_eq!(
            Rrn::parse(&digits).map(|v| v.digits().to_owned()),
            Ok(digits)
        );
    }
    if let Some(column) = grid::parse_column_letter(text) {
        assert_eq!(
            grid::parse_column_letter(&grid::column_letter(column)),
            Some(column)
        );
    }
});
