//! Personal details extras HR holds on an employee (MR-34, lane EMP-FACTS):
//! name in Chinese characters · English name, nationality, personal email,
//! emergency contacts, photo and group hire date (the service start date an
//! import's group hire date column maps to).
//!
//! None of them is a worker register item (Labor Standards Act Enforcement
//! Decree §20); they are optional company fields, so NULL stays not entered
//! and nothing is defaulted (Personal Information Protection Act §16
//! minimisation). An emergency contact is a third person's data: at most
//! [`MAX_EMERGENCY_CONTACTS`], never imported by default.
//!
//! Pure: values in, typed values or a coded `KernelError` out.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::{Date, Month};

/// The correction fields this module owns (`employee_corrections.field`).
pub const PERSONAL_FIELDS: [&str; 7] = [
    "name_hanja",
    "name_en",
    "nationality",
    "personal_email",
    "emergency_contacts",
    "photo",
    "group_service_start_date",
];

/// Most emergency contacts one employee holds (third-party data, kept small).
pub const MAX_EMERGENCY_CONTACTS: usize = 3;

/// The photo types a browser renders as an image. No SVG: it is a document
/// that can carry script.
pub const PHOTO_CONTENT_TYPES: [&str; 3] = ["image/jpeg", "image/png", "image/webp"];

/// The largest photo accepted, in bytes (5 MiB).
pub const PHOTO_MAX_BYTES: i64 = 5 * 1024 * 1024;

fn invalid(field: &str, message: impl Into<String>) -> KernelError {
    KernelError::validation(message.into()).with_field(field)
}

/// Trimmed, inner whitespace collapsed to one space; `None` when blank.
fn collapse(raw: &str) -> Option<String> {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

const fn is_hanja(c: char) -> bool {
    matches!(c,
        '\u{3400}'..='\u{4DBF}'      // CJK Unified Ideographs Extension A
        | '\u{4E00}'..='\u{9FFF}'    // CJK Unified Ideographs
        | '\u{F900}'..='\u{FAFF}'    // CJK Compatibility Ideographs (Korean readings)
        | '\u{20000}'..='\u{2FA1F}') // Extensions B.. and the compatibility supplement
}

/// Name in Chinese characters: CJK ideographs (spaces allowed between parts),
/// at most 30.
///
/// # Errors
/// Validation when a character is not a Chinese character or the name is too
/// long.
pub fn normalize_name_hanja(raw: &str) -> Result<Option<String>, KernelError> {
    let Some(name) = collapse(raw) else {
        return Ok(None);
    };
    if name.chars().count() > 30 || !name.chars().all(|c| c == ' ' || is_hanja(c)) {
        return Err(invalid(
            "name_hanja",
            "name_hanja must be 한자 (CJK ideographs), 30 characters or fewer",
        ));
    }
    Ok(Some(name))
}

fn is_latin_letter(c: char) -> bool {
    c.is_ascii_alphabetic()
        || (('\u{C0}'..='\u{24F}').contains(&c) && c.is_alphabetic() && c != '×' && c != '÷')
}

/// English name as written (passport style or not): Latin letters, spaces and
/// `- ' . ,`, at most 100; the case is kept as typed.
///
/// # Errors
/// Validation on any other character, no letter at all, or too long.
pub fn normalize_name_en(raw: &str) -> Result<Option<String>, KernelError> {
    let Some(name) = collapse(raw) else {
        return Ok(None);
    };
    let allowed = |c: char| is_latin_letter(c) || matches!(c, ' ' | '-' | '\'' | '.' | ',');
    if name.chars().count() > 100
        || !name.chars().all(allowed)
        || !name.chars().any(is_latin_letter)
    {
        return Err(invalid(
            "name_en",
            "name_en must be Latin letters with spaces, - ' . or , (100 characters or fewer)",
        ));
    }
    Ok(Some(name))
}

/// Nationality: an ISO 3166-1 alpha-2 code, upper case. NULL is not entered
/// (never KR by default).
/// This pure normalizer checks shape; the correction transaction checks
/// membership against the dated database catalog.
///
/// # Errors
/// Validation when the value is not two letters.
pub fn normalize_nationality(raw: &str) -> Result<Option<String>, KernelError> {
    let code = raw.trim().to_ascii_uppercase();
    if code.is_empty() {
        return Ok(None);
    }
    if code.len() != 2 || !code.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(invalid(
            "nationality",
            "nationality must be an ISO 3166-1 alpha-2 code such as KR",
        ));
    }
    Ok(Some(code))
}

/// How an emergency contact relates to the employee.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ContactRelation {
    Spouse,
    Parent,
    Child,
    Sibling,
    Relative,
    Other,
}

impl ContactRelation {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Spouse => "SPOUSE",
            Self::Parent => "PARENT",
            Self::Child => "CHILD",
            Self::Sibling => "SIBLING",
            Self::Relative => "RELATIVE",
            Self::Other => "OTHER",
        }
    }
}

/// One emergency contact as the client sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmergencyContactInput {
    pub name: String,
    pub relation: ContactRelation,
    pub phone: String,
    /// Employee confirmation that the contact was told about registration.
    #[serde(default)]
    pub contact_notified: Option<bool>,
}

/// A checked emergency contact; the phone is normalized to E.164 by the adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmergencyContact {
    pub name: String,
    pub relation: ContactRelation,
    pub phone: String,
    pub contact_notified: bool,
}

/// Checks the whole emergency contact list (an empty list clears it).
///
/// # Errors
/// Validation on too many rows, a blank or long name, or a blank phone.
pub fn normalize_emergency_contacts(
    rows: Vec<EmergencyContactInput>,
) -> Result<Vec<EmergencyContact>, KernelError> {
    if rows.len() > MAX_EMERGENCY_CONTACTS {
        return Err(invalid(
            "emergency_contacts",
            format!("emergency_contacts holds at most {MAX_EMERGENCY_CONTACTS} people"),
        ));
    }
    rows.into_iter()
        .enumerate()
        .map(|(index, row)| {
            let at = |name: &str| format!("emergency_contacts[{index}].{name}");
            let name = collapse(&row.name)
                .filter(|name| name.chars().count() <= 50)
                .ok_or_else(|| invalid(&at("name"), "name is required, 50 characters or fewer"))?;
            let phone = row.phone.trim().to_owned();
            if phone.is_empty() {
                return Err(invalid(&at("phone"), "phone is required"));
            }
            Ok(EmergencyContact {
                name,
                relation: row.relation,
                phone,
                contact_notified: row.contact_notified.unwrap_or(false),
            })
        })
        .collect()
}

/// New or changed contacts need notice confirmation; stored rows can be kept or restored.
///
/// # Errors
/// Typed validation when an unconfirmed contact has no matching stored evidence.
pub fn validate_emergency_contacts(
    rows: &[EmergencyContact],
    recorded: &[EmergencyContact],
) -> Result<(), KernelError> {
    let mut available = recorded.to_vec();
    for row in rows {
        let existing = available.iter().position(|old| old == row);
        if let Some(index) = existing {
            available.swap_remove(index);
        } else if !row.contact_notified {
            return Err(KernelError::validation(
                "emergency contact cannot be saved without the employee's confirmation that the contact was told (검토 전; conservative basis pending counsel, not consent)",
            ).with_code("emergency_contact_notice_unconfirmed"));
        }
    }
    Ok(())
}

/// A photo upload's declared type and size; returns the canonical type.
///
/// # Errors
/// Validation for a type outside [`PHOTO_CONTENT_TYPES`] or a size outside
/// `1..=PHOTO_MAX_BYTES`.
pub fn check_photo(content_type: &str, byte_size: i64) -> Result<&'static str, KernelError> {
    let lowered = content_type.trim().to_ascii_lowercase();
    let canonical = PHOTO_CONTENT_TYPES
        .into_iter()
        .find(|known| *known == lowered)
        .ok_or_else(|| invalid("content_type", "a photo must be JPEG, PNG or WebP"))?;
    if !(1..=PHOTO_MAX_BYTES).contains(&byte_size) {
        return Err(invalid(
            "byte_size",
            format!("a photo must be 1 to {PHOTO_MAX_BYTES} bytes"),
        ));
    }
    Ok(canonical)
}

/// Group hire date (service start date): the day continuous service in the
/// group began. It counts toward the period of continuous service (Labor
/// Standards Act §60 annual leave, Employee Retirement Benefit Security Act
/// §8), so it is never after the hire date here and not before 1900.
///
/// # Errors
/// Validation when the date is after `hire` or before 1900-01-01.
pub fn validate_group_service_start(start: Date, hire: Option<Date>) -> Result<(), KernelError> {
    let floor = Date::from_calendar_date(1900, Month::January, 1)
        .map_err(|_| KernelError::internal("group service start floor"))?;
    if start < floor || hire.is_some_and(|hire| start > hire) {
        return Err(invalid(
            "group_service_start_date",
            "group_service_start_date must be on or before the hire date (and not before 1900)",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
