//! The ZIP container of an `.xlsx`, walked before any parser sees it: every
//! entry of the central directory, its real inflated size (counted, not the
//! declared one) and the caps of [`WorkbookCaps`]. Stdlib only; refuses
//! ZIP64, encryption and any method but stored/deflate.

use std::borrow::Cow;
use std::collections::HashMap;

use super::inflate::{InflateError, inflated_bytes, inflated_len};
use super::{WorkbookCaps, codes};

const EOCD_SIG: u32 = 0x0605_4b50;
const CDH_SIG: u32 = 0x0201_4b50;
const LFH_SIG: u32 = 0x0403_4b50;
/// Entries smaller than this are never a bomb; the ratio cap applies above it.
// fixed floor; a registry key if an operator ever needs to tune it.
const RATIO_FLOOR_BYTES: u64 = 1 << 20;

/// What the scan saw of a workbook that passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ZipStats {
    pub entries: usize,
    pub expanded_bytes: u64,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn eocd(bytes: &[u8]) -> Option<usize> {
    let floor = bytes.len().saturating_sub(22 + usize::from(u16::MAX));
    (floor..=bytes.len().checked_sub(22)?)
        .rev()
        .find(|&at| u32_at(bytes, at) == Some(EOCD_SIG))
}

struct Entry<'a> {
    name: &'a [u8],
    method: u16,
    flags: u16,
    compressed: u64,
    declared: u64,
    local: usize,
}

fn entries<'a>(bytes: &'a [u8], caps: &WorkbookCaps) -> Result<Vec<Entry<'a>>, &'static str> {
    let end = eocd(bytes).ok_or(codes::CORRUPT)?;
    let total = u16_at(bytes, end + 10).ok_or(codes::CORRUPT)?;
    let mut at = u32_at(bytes, end + 16).ok_or(codes::CORRUPT)? as usize;
    if total == u16::MAX || at == u32::MAX as usize {
        return Err(codes::EXPANDS_TOO_FAR);
    }
    if usize::from(total) > caps.max_entries {
        return Err(codes::TOO_MANY_ENTRIES);
    }
    let mut out = Vec::with_capacity(usize::from(total));
    for _ in 0..total {
        if u32_at(bytes, at) != Some(CDH_SIG) {
            return Err(codes::CORRUPT);
        }
        let field = |off: usize| u16_at(bytes, at + off).ok_or(codes::CORRUPT);
        let word = |off: usize| u32_at(bytes, at + off).ok_or(codes::CORRUPT);
        let (compressed, declared, local) = (word(20)?, word(24)?, word(42)?);
        if [compressed, declared, local].contains(&u32::MAX) {
            return Err(codes::EXPANDS_TOO_FAR);
        }
        let name_end = at + 46 + usize::from(field(28)?);
        out.push(Entry {
            name: bytes.get(at + 46..name_end).ok_or(codes::CORRUPT)?,
            flags: field(8)?,
            method: field(10)?,
            compressed: u64::from(compressed),
            declared: u64::from(declared),
            local: local as usize,
        });
        at += 46 + usize::from(field(28)?) + usize::from(field(30)?) + usize::from(field(32)?);
    }
    Ok(out)
}

fn data<'a>(bytes: &'a [u8], entry: &Entry<'_>) -> Result<&'a [u8], &'static str> {
    let at = entry.local;
    if u32_at(bytes, at) != Some(LFH_SIG) {
        return Err(codes::CORRUPT);
    }
    let name = usize::from(u16_at(bytes, at + 26).ok_or(codes::CORRUPT)?);
    let extra = usize::from(u16_at(bytes, at + 28).ok_or(codes::CORRUPT)?);
    let start = at + 30 + name + extra;
    let len = usize::try_from(entry.compressed).map_err(|_| codes::CORRUPT)?;
    bytes.get(start..start + len).ok_or(codes::CORRUPT)
}

/// Walks every entry and counts what it really inflates to.
///
/// # Errors
/// A typed refusal code (see [`codes`]): too many entries, more inflated
/// bytes than the cap, an entry inflating past the ratio cap, or a container
/// that is not a plain stored/deflate ZIP.
pub fn scan_zip(bytes: &[u8], caps: &WorkbookCaps) -> Result<ZipStats, &'static str> {
    let list = entries(bytes, caps)?;
    let mut stats = ZipStats {
        entries: list.len(),
        expanded_bytes: 0,
    };
    for entry in &list {
        if entry.flags & 1 != 0 {
            return Err(codes::CORRUPT);
        }
        let budget = caps.max_expanded_bytes.saturating_sub(stats.expanded_bytes);
        let raw = data(bytes, entry)?;
        let size = match entry.method {
            0 => entry.compressed,
            8 => inflated_len(raw, budget).map_err(|error| match error {
                InflateError::Limit => codes::EXPANDS_TOO_FAR,
                InflateError::Invalid => codes::CORRUPT,
            })?,
            _ => return Err(codes::CORRUPT),
        };
        if size != entry.declared {
            return Err(codes::CORRUPT);
        }
        if size > budget {
            return Err(codes::EXPANDS_TOO_FAR);
        }
        if size > RATIO_FLOOR_BYTES && size / entry.compressed.max(1) > caps.max_ratio {
            return Err(codes::COMPRESSION_RATIO);
        }
        stats.expanded_bytes += size;
    }
    Ok(stats)
}

/// Validate worksheet dimension declarations after the container has passed its caps.
///
/// # Errors
/// [`codes::CORRUPT`] for invalid dimensions, or a container refusal from [`scan_zip`].
pub fn check_dimensions(bytes: &[u8], caps: &WorkbookCaps) -> Result<(), &'static str> {
    scan_zip(bytes, caps)?;
    let list = entries(bytes, caps)?;
    // Match calamine's case-insensitive ZIP cache, including backslash entry names.
    let parts: HashMap<_, _> = list
        .iter()
        .map(|entry| {
            let name: Vec<_> = entry
                .name
                .iter()
                .map(|b| {
                    if *b == b'\\' {
                        b'/'
                    } else {
                        b.to_ascii_lowercase()
                    }
                })
                .collect();
            (name, entry)
        })
        .collect();
    let part = |name: &str| -> Result<Cow<'_, [u8]>, &'static str> {
        let entry = parts
            .get(&name.as_bytes().to_ascii_lowercase())
            .ok_or(codes::CORRUPT)?;
        let raw = data(bytes, entry)?;
        if entry.method == 8 {
            inflated_bytes(raw, entry.declared)
                .map(Cow::Owned)
                .map_err(|_| codes::CORRUPT)
        } else {
            Ok(Cow::Borrowed(raw))
        }
    };
    let mut relationships = HashMap::new();
    super::dimension::tags(&part("xl/_rels/workbook.xml.rels")?, |name, attributes| {
        if name == b"Relationship" {
            let values = super::dimension::attributes(attributes).ok_or(codes::CORRUPT)?;
            let value = |key: &[u8]| values.get(key).copied();
            if let (Some(id), Some(target)) = (value(b"Id"), value(b"Target")) {
                let target = std::str::from_utf8(target).map_err(|_| codes::CORRUPT)?;
                // Same target resolution as calamine's read_workbook.
                let path = if let Some(path) = target.strip_prefix("/xl/") {
                    format!("xl/{path}")
                } else if target.starts_with("xl/") {
                    target.to_owned()
                } else {
                    format!("xl/{target}")
                };
                relationships.insert(id.to_vec(), path);
            }
        }
        Ok(true)
    })?;
    super::dimension::tags(&part("xl/workbook.xml")?, |name, attributes| {
        if name == b"sheet" {
            for (key, id) in super::dimension::attributes(attributes).ok_or(codes::CORRUPT)? {
                if key.splitn(2, |b| *b == b':').last() == Some(b"id".as_slice()) {
                    let path = relationships.get(id).ok_or(codes::CORRUPT)?;
                    super::dimension::check(&part(path)?)?;
                }
            }
        }
        Ok(true)
    })?;
    Ok(())
}
