//! Text scans of block-mapping YAML lines (not a YAML parse).
//!
//! A single-quoted scalar ends at the first lone `'` (`''` is an escaped
//! quote). A stray apostrophe (`the run's job`) closes it early and the rest
//! of the line is junk to every YAML parser — `openapi-typescript` refused the
//! published file for exactly that. Same honesty as
//! [`crate::first_plain_scalar_colon`]: block-mapping values only; flow
//! collections and sequence items are skipped.

/// First line (1-based) where a single-quoted value closes with text left on
/// the line, on the `key: '…` line itself or on a continuation line.
pub fn first_single_quote_closed_early(doc: &str) -> Option<(usize, &str)> {
    let mut open = false;
    for (index, line) in doc.lines().enumerate() {
        let mut rest = if open {
            line
        } else {
            let trimmed = line.trim_start();
            let body = trimmed.strip_prefix("- ").unwrap_or(trimmed);
            if body.starts_with(['#', '{', '[']) {
                continue;
            }
            match mapping_value(body).and_then(|v| v.strip_prefix('\'')) {
                Some(after_quote) => after_quote,
                None => continue,
            }
        };
        open = loop {
            let Some(at) = rest.find('\'') else {
                break true;
            };
            if rest[at + 1..].starts_with('\'') {
                rest = &rest[at + 2..];
                continue;
            }
            let tail = rest[at + 1..].trim();
            if !tail.is_empty() && !tail.starts_with('#') {
                return Some((index + 1, line));
            }
            break false;
        };
    }
    None
}

/// The value after a block-mapping key (`key: value` / `key:`), trimmed;
/// `None` when the line is not a mapping entry.
pub(crate) fn mapping_value(body: &str) -> Option<&str> {
    let after_key = if let Some(quote @ ('\'' | '"')) = body.chars().next() {
        let close = body[1..].find(quote)? + 1;
        &body[close + 1..]
    } else {
        let colon = body
            .find(": ")
            .or_else(|| body.ends_with(':').then(|| body.len() - 1))?;
        &body[colon..]
    };
    Some(after_key.strip_prefix(':')?.trim())
}
