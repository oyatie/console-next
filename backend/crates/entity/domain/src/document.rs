//! Evidence documents (entity design §5): what may be uploaded, and when a
//! superseded original may be disposed of. Pure.
//!
//! There is no extraction (lane corrections #10): the admin types every
//! field beside the document, and the original is kept as evidence.

use crate::code_enum;
use crate::refusal::Refusal;

code_enum! {
    /// What a document is evidence of.
    DocumentKind {
        BizRegCert => "BIZ_REG_CERT",
        CorpRegistryExtract => "CORP_REGISTRY_EXTRACT",
        InsuranceNotice => "INSURANCE_NOTICE",
        Other => "OTHER",
    }
}

/// Upload ceiling (design §5: 「PDF or image of up to 10 MB」; the table CHECK
/// enforces the same number).
pub const MAX_BYTES: usize = 10 * 1024 * 1024;

/// The accepted formats, decided from the bytes, never from the client's
/// declared type or the file name.
#[must_use]
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else {
        None
    }
}

/// A checked upload, ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentUpload {
    pub kind: DocumentKind,
    pub file_name: String,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

/// Validate an upload: a known kind, a file name, a non-empty body within
/// [`MAX_BYTES`] whose bytes are a PDF, JPEG or PNG.
///
/// # Errors
/// 422 naming `kind`, `file` or `file_name`.
pub fn validate_upload(
    kind: Option<&str>,
    file_name: Option<&str>,
    bytes: Vec<u8>,
) -> Result<DocumentUpload, Refusal> {
    let kind = match kind.map(str::trim).filter(|k| !k.is_empty()) {
        None => return Err(Refusal::field("kind", "required")),
        Some(k) => {
            DocumentKind::parse(k).ok_or_else(|| Refusal::field("kind", "invalid_option"))?
        }
    };
    if bytes.is_empty() {
        return Err(Refusal::field("file", "required"));
    }
    if bytes.len() > MAX_BYTES {
        return Err(Refusal::field("file", "file_too_large"));
    }
    let content_type =
        sniff(&bytes).ok_or_else(|| Refusal::field("file", "file_type_not_accepted"))?;
    // The name is kept for the 문서 tab only; path parts never reach storage.
    let file_name = file_name
        .and_then(|n| n.rsplit(['/', '\\']).next())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| Refusal::field("file_name", "required"))?;
    if file_name.chars().count() > 255 {
        return Err(Refusal::field("file_name", "too_long"));
    }
    Ok(DocumentUpload {
        kind,
        file_name: file_name.to_owned(),
        content_type,
        bytes,
    })
}

/// Until when a superseded original is kept: the same calendar day `years`
/// after the day it was superseded (KST). A 29 February anchor without a
/// corresponding day lands on the month's end, 28 February (민법 §160③).
/// The disposition job (GOV-AUD) decides on its own reading of the setting.
#[must_use]
pub fn retain_until(superseded_on: time::Date, years: i64) -> Option<time::Date> {
    let year = superseded_on
        .year()
        .checked_add(i32::try_from(years).ok()?)?;
    superseded_on
        .replace_year(year)
        .ok()
        .or_else(|| time::Date::from_calendar_date(year, time::Month::February, 28).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn uploads_are_typed_by_their_bytes() {
        let pdf = b"%PDF-1.7 ...".to_vec();
        let ok = validate_upload(
            Some("BIZ_REG_CERT"),
            Some("C:\\scans\\cert.pdf"),
            pdf.clone(),
        )
        .unwrap();
        assert_eq!(
            (ok.kind, ok.content_type, ok.file_name.as_str()),
            (DocumentKind::BizRegCert, "application/pdf", "cert.pdf")
        );
        let code = |r: Result<DocumentUpload, Refusal>| r.unwrap_err().fields[0].code;
        assert_eq!(
            code(validate_upload(
                Some("BIZ_REG_CERT"),
                Some("x.pdf"),
                b"MZ\x90".to_vec()
            )),
            "file_type_not_accepted"
        );
        assert_eq!(
            code(validate_upload(Some("NOPE"), Some("x.pdf"), pdf.clone())),
            "invalid_option"
        );
        assert_eq!(
            code(validate_upload(None, Some("x.pdf"), pdf.clone())),
            "required"
        );
        assert_eq!(
            code(validate_upload(Some("OTHER"), Some("x.pdf"), vec![])),
            "required"
        );
        assert_eq!(
            code(validate_upload(Some("OTHER"), Some("  "), pdf)),
            "required"
        );
        let mut big = b"%PDF-".to_vec();
        big.resize(MAX_BYTES + 1, 0);
        assert_eq!(
            code(validate_upload(Some("OTHER"), Some("x.pdf"), big)),
            "file_too_large"
        );
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
    }

    #[test]
    fn retention_runs_whole_years_from_supersession() {
        assert_eq!(
            retain_until(date!(2026 - 10 - 05), 5),
            Some(date!(2031 - 10 - 05))
        );
        assert_eq!(
            retain_until(date!(2028 - 02 - 29), 5),
            Some(date!(2033 - 02 - 28))
        );
        assert_eq!(
            retain_until(date!(2028 - 02 - 29), 4),
            Some(date!(2032 - 02 - 29))
        );
    }
}
