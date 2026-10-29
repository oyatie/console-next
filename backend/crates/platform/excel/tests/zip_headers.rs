// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use console_platform_excel::{roundtrip_workbook_bytes, umya_spreadsheet};

#[test]
fn inconsistent_zip_local_headers_are_refused() {
    let book = umya_spreadsheet::new_file();
    let mut bytes = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes).unwrap();
    assert!(roundtrip_workbook_bytes(&bytes).is_ok());
    let name = b"xl/workbook.xml";
    let header = bytes
        .windows(30 + name.len())
        .position(|part| part.starts_with(b"PK\x03\x04") && &part[30..] == name)
        .unwrap();
    // GHSA-m665-v7pm-7grj: change the local filename or compression method only.
    for offset in [30, 8] {
        let mut inconsistent = bytes.clone();
        inconsistent[header + offset] ^= 1;
        assert!(roundtrip_workbook_bytes(&inconsistent).is_err());
    }
}
