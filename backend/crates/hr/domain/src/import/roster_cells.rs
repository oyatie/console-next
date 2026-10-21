//! W12: roster cells the import used to misread — a totals / footer row
//! (`합계 | 300명`) taken for a person, a phone number Excel stored as a
//! number (leading 0 lost), and the memory key of a sheet the operator skips.

use console_kernel_core::kr::PhoneE164;

use super::cells::{half_width, parse_import_date};
use super::detect::memory_key;
use super::grid::GridRow;

/// Cells that mark a totals row. `계` alone is a surname too, so a token is
/// never enough on its own (see [`is_summary_row`]).
const SUMMARY_TOKENS: [&str; 12] = [
    "합계",
    "총계",
    "소계",
    "누계",
    "계",
    "총",
    "합",
    "총인원",
    "인원합계",
    "total",
    "subtotal",
    "sum",
];

fn key(text: &str) -> String {
    half_width(text)
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// A count as a footer writes it: `300`, `300명`, `1,234 인`.
fn is_count(text: &str) -> bool {
    let k = key(text).replace(',', "");
    let digits = k.trim_end_matches(['명', '인', '건']);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// A totals / footer row: some cell is a totals word, the 성명 cell is
/// empty, a totals word or a count, and the 입사일 cell is not a date. All
/// three, so a person named 「계」 with an 입사일 stays a person.
#[must_use]
pub fn is_summary_row(row: &GridRow, name: Option<u32>, hire: Option<u32>) -> bool {
    let token = |text: &str| SUMMARY_TOKENS.contains(&key(text).as_str());
    let has_token = row.cells.iter().any(|(_, cell)| token(&cell.text()));
    let name_text = name.map(|c| row.text(c)).unwrap_or_default();
    let not_a_name = name_text.is_empty() || token(&name_text) || is_count(&name_text);
    let hire_text = hire.map(|c| row.text(c)).unwrap_or_default();
    has_token && not_a_name && parse_import_date(&hire_text).is_none()
}

/// A phone cell as E.164. A number cell lost its leading 0 (`1012345678` is
/// 010-1234-5678); a domestic number never starts with another digit.
/// `None`: not a phone number.
#[must_use]
pub fn import_phone(text: &str) -> Option<String> {
    let text = half_width(text.trim());
    // Only digits and separators: a letter is never dropped into a number.
    if !text
        .chars()
        .all(|c| c.is_ascii_digit() || " -.()+".contains(c))
    {
        return None;
    }
    let digits = text.bytes().all(|b| b.is_ascii_digit());
    let representative = text.len() == 8 && ["15", "16", "18"].iter().any(|p| text.starts_with(p));
    let restored = if digits && !text.starts_with('0') && !text.starts_with("82") && !representative
    {
        format!("0{text}")
    } else {
        text
    };
    PhoneE164::parse(&restored)
        .ok()
        .map(|phone| phone.as_str().to_owned())
}

/// The mapping-memory key of a sheet name. Header keys never hold `:`
/// ([`memory_key`] strips it), so the two never collide.
#[must_use]
pub fn sheet_memory_key(sheet: &str) -> String {
    format!("sheet:{}", memory_key(sheet))
}

#[cfg(test)]
#[path = "roster_cells_tests.rs"]
mod tests;
