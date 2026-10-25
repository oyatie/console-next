//! G9 (BW-10): what an uploaded workbook is before a parser touches it, and
//! the column notices the preview shows.

/// An `.xlsx` is a ZIP (OOXML). A password-protected one, and the DRM wrappers
/// Korean offices use, are an OLE2 compound file instead: the parser would
/// only say "invalid zip", so the upload is refused by what it is.
///
/// # Errors
/// `workbook_protected` for an OLE2 container (암호 또는 DRM), `workbook_not_xlsx`
/// for anything else that is not a ZIP.
pub fn check_workbook_signature(bytes: &[u8]) -> Result<(), &'static str> {
    const ZIP: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];
    const OLE2: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    if bytes.starts_with(&ZIP) {
        Ok(())
    } else if bytes.starts_with(&OLE2) {
        Err("workbook_protected")
    } else {
        Err("workbook_not_xlsx")
    }
}

/// Column meaning comes from its mapping and values, never a global notice.
#[must_use]
pub fn header_notice(_normalized_header: &str) -> Option<&'static str> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workbook_is_known_by_its_first_bytes() {
        assert_eq!(check_workbook_signature(b"PK\x03\x04rest"), Ok(()));
        let ole = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0];
        assert_eq!(check_workbook_signature(&ole), Err("workbook_protected"));
        assert_eq!(
            check_workbook_signature(b"name,phone\n"),
            Err("workbook_not_xlsx")
        );
        assert_eq!(check_workbook_signature(b""), Err("workbook_not_xlsx"));
    }

    #[test]
    fn place_model_never_decides_a_column_meaning_by_its_header() {
        assert_eq!(header_notice("사업장"), None);
        assert_eq!(header_notice("근무사업장"), None);
        assert_eq!(header_notice("사업장주소"), None);
        assert_eq!(header_notice("근무지"), None);
    }
}
