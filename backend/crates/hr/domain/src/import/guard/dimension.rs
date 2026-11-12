// SPDX-License-Identifier: LicenseRef-Proprietary
//! Preflight the dimension tokens calamine consumes before constructing a cell reader.

use super::codes;

// XLSX format limits, independent of the tenant's lower import budgets.
const MAX_ROWS: u32 = 1_048_576;
const MAX_COLUMNS: u32 = 16_384;

fn coordinate(value: &[u8]) -> Option<(u32, u32)> {
    let split = value.iter().position(u8::is_ascii_digit)?;
    let (letters, digits) = value.split_at(split);
    if letters.is_empty() || digits.is_empty() {
        return None;
    }
    let column = letters.iter().try_fold(0u32, |n, byte| {
        byte.is_ascii_alphabetic().then_some(())?;
        n.checked_mul(26)?
            .checked_add(u32::from(byte.to_ascii_uppercase() - b'A') + 1)
    })?;
    let row = digits.iter().try_fold(0u32, |n, byte| {
        byte.is_ascii_digit().then_some(())?;
        n.checked_mul(10)?.checked_add(u32::from(byte - b'0'))
    })?;
    (row > 0 && row <= MAX_ROWS && column <= MAX_COLUMNS).then_some((row, column))
}

fn valid(value: &[u8]) -> bool {
    let mut parts = value.split(|byte| *byte == b':');
    let Some(start) = parts.next().and_then(coordinate) else {
        return false;
    };
    match parts.next() {
        None => true,
        Some(end) => {
            parts.next().is_none()
                && coordinate(end).is_some_and(|end| end.0 >= start.0 && end.1 >= start.1)
        }
    }
}

fn reference(mut attributes: &[u8]) -> Option<&[u8]> {
    let mut reference = None;
    loop {
        attributes = attributes.trim_ascii_start();
        if attributes.is_empty() || attributes == b"/" {
            return reference;
        }
        let end = attributes
            .iter()
            .position(|b| b.is_ascii_whitespace() || *b == b'=')?;
        let name = &attributes[..end];
        attributes = attributes[end..]
            .trim_ascii_start()
            .strip_prefix(b"=")?
            .trim_ascii_start();
        let (&quote, rest) = attributes.split_first()?;
        if !matches!(quote, b'\'' | b'"') {
            return None;
        }
        let end = rest.iter().position(|b| *b == quote)?;
        if name == b"ref" {
            if reference.is_some() {
                return None;
            }
            reference = Some(&rest[..end]);
        }
        attributes = &rest[end + 1..];
    }
}

/// Inspect markup, skipping comments, processing instructions and CDATA so text
/// resembling a dimension does not refuse an otherwise valid workbook.
///
/// # Errors
/// [`codes::CORRUPT`] for an invalid dimension or a DTD (not used by XLSX).
pub(super) fn check(mut xml: &[u8]) -> Result<(), &'static str> {
    while let Some(start) = xml.iter().position(|b| *b == b'<') {
        xml = &xml[start + 1..];
        let terminator = if xml.starts_with(b"!--") {
            Some(b"-->".as_slice())
        } else if xml.starts_with(b"![CDATA[") {
            Some(b"]]>".as_slice())
        } else if xml.starts_with(b"?") {
            Some(b"?>".as_slice())
        } else {
            None
        };
        if let Some(end) = terminator {
            let Some(at) = xml.windows(end.len()).position(|w| w == end) else {
                return Ok(()); // The XML reader reports unfinished markup.
            };
            xml = &xml[at + end.len()..];
            continue;
        }
        if xml.starts_with(b"!DOCTYPE") {
            return Err(codes::CORRUPT);
        }
        let mut quote = None;
        let Some(end) = xml.iter().position(|b| match (quote, *b) {
            (Some(q), b) if q == b => {
                quote = None;
                false
            }
            (None, b'\'' | b'"') => {
                quote = Some(*b);
                false
            }
            (None, b'>') => true,
            _ => false,
        }) else {
            return Ok(());
        };
        let tag = &xml[..end];
        let name_end = tag
            .iter()
            .position(|b| b.is_ascii_whitespace() || *b == b'/')
            .unwrap_or(tag.len());
        let name = tag[..name_end]
            .rsplit(|b| *b == b':')
            .next()
            .unwrap_or_default();
        if name == b"sheetData" {
            return Ok(());
        }
        if name == b"dimension" && !reference(&tag[name_end..]).is_some_and(valid) {
            return Err(codes::CORRUPT);
        }
        xml = &xml[end + 1..];
    }
    Ok(())
}
