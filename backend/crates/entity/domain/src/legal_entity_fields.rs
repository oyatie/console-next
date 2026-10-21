//! Fields shared by entity and certificate validation.
use super::{CODE_UNVERIFIED, CodeInput, CodeRef, Director, DirectorInput};
use crate::codes::DirectorRole;
use crate::refusal::{INVALID_OPTION, Issues, OUT_OF_RANGE, REQUIRED};

pub(super) fn representatives(is: &mut Issues, raw: &[String]) -> Vec<String> {
    if raw.iter().all(|n| n.trim().is_empty()) {
        is.push("representatives", REQUIRED);
        return Vec::new();
    }
    if raw.len() > 50 {
        is.push("representatives", OUT_OF_RANGE);
        return Vec::new();
    }
    raw.iter()
        .enumerate()
        .filter_map(|(i, n)| is.text(&format!("representatives[{i}]"), Some(n), 100, true))
        .collect()
}

pub(super) fn directors(
    is: &mut Issues,
    raw: &[DirectorInput],
    today: time::Date,
) -> Vec<Director> {
    raw.iter()
        .enumerate()
        .filter_map(|(i, d)| {
            let p = |f: &str| format!("directors[{i}].{f}");
            let role = is.choice(&p("role"), d.role.as_deref(), true, DirectorRole::parse);
            let name = is.text(&p("name"), d.name.as_deref(), 100, true);
            let appointed_on = is.date(
                &p("appointed_on"),
                d.appointed_on.as_deref(),
                false,
                Some(today),
            );
            Some(Director {
                role: role?,
                name: name?,
                appointed_on,
            })
        })
        .collect()
}

/// A KSIC code (한국표준산업분류: optional section letter A–U, then 2–5
/// digits), stamped `UNVERIFIED` with the printed text (or the code) as its
/// label until a reference list is loaded.
pub(crate) fn code_ref(
    is: &mut Issues,
    field: &str,
    raw: &CodeInput,
    printed: Option<&str>,
) -> Option<CodeRef> {
    let field = format!("{field}.code");
    let code = is
        .text(&field, raw.code.as_deref(), 20, true)?
        .to_ascii_uppercase();
    let digits = code
        .strip_prefix(|c: char| ('A'..='U').contains(&c))
        .unwrap_or(&code);
    if !(2..=5).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        is.push(field, INVALID_OPTION);
        return None;
    }
    let label = printed
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or(&code)
        .to_owned();
    Some(CodeRef {
        label,
        code,
        version: CODE_UNVERIFIED.to_owned(),
    })
}
