//! The container walk against the Excel-made report templates (shape only:
//! no cell is read or printed) and hand-built ZIPs: honest and forged bombs,
//! entry floods, ZIP64 markers, encryption, and random corruption.
#![allow(clippy::unwrap_used)]

use super::inflate::tests::{Rng, bomb};
use super::zip::scan_zip;
use super::*;

pub(super) const CAPS: WorkbookCaps = WorkbookCaps {
    max_upload_bytes: 16 << 20,
    max_entries: 1_000,
    max_expanded_bytes: 128 << 20,
    max_ratio: 200,
    max_grid_cells: 5_000_000,
    max_cells: 2_000_000,
};

/// A ZIP of `(name, method, data, declared size)` entries.
fn zip(entries: &[(&str, u16, Vec<u8>, u32)]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, method, data, declared) in entries {
        let offset = out.len() as u32;
        let header = |sig: u32, central: bool| {
            let mut h = sig.to_le_bytes().to_vec();
            if central {
                h.extend_from_slice(&20u16.to_le_bytes());
            }
            h.extend_from_slice(&20u16.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            h.extend_from_slice(&method.to_le_bytes());
            h.extend_from_slice(&[0; 8]);
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&declared.to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            if central {
                h.extend_from_slice(&[0; 10]);
                h.extend_from_slice(&offset.to_le_bytes());
            }
            h.extend_from_slice(name.as_bytes());
            h
        };
        out.extend(header(0x0403_4b50, false));
        out.extend_from_slice(data);
        central.extend(header(0x0201_4b50, true));
    }
    let (cd_at, cd_len, n) = (out.len() as u32, central.len() as u32, entries.len() as u16);
    out.extend(central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&cd_len.to_le_bytes());
    out.extend_from_slice(&cd_at.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn reference_workbooks() -> Vec<Vec<u8>> {
    // The report templates (platform/excel/templates): Excel-made packages kept in the repository.
    let dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../platform/excel/templates"
    );
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "xlsx"))
        .collect();
    files.sort();
    files.iter().map(|p| std::fs::read(p).unwrap()).collect()
}

#[test]
fn both_reference_workbooks_pass_and_inflate_to_their_declared_sizes() {
    let books = reference_workbooks();
    assert_eq!(books.len(), 2);
    for book in &books {
        let stats = scan_zip(book, &CAPS).unwrap();
        assert!(
            stats.entries > 8,
            "reference workbooks contain normal XLSX parts"
        );
        // Content types, two rels, workbook, sheet, styles, theme, strings, two document properties.
        assert!(stats.entries >= 10, "an Excel-made workbook package");
        assert!(stats.expanded_bytes > book.len() as u64);
    }
}

#[test]
fn honest_and_forged_bombs_are_refused() {
    let stream = bomb(20_000);
    let out = 1 + 20_000 * 258;
    let honest = zip(&[("xl/sharedStrings.xml", 8, stream.clone(), out)]);
    let tight = WorkbookCaps {
        max_ratio: 50,
        ..CAPS
    };
    assert_eq!(scan_zip(&honest, &tight), Err(codes::COMPRESSION_RATIO));
    let small = WorkbookCaps {
        max_expanded_bytes: 1 << 20,
        ..CAPS
    };
    assert_eq!(scan_zip(&honest, &small), Err(codes::EXPANDS_TOO_FAR));
    // The central directory claims 100 bytes; the real count decides.
    let forged = zip(&[("xl/sharedStrings.xml", 8, stream, 100)]);
    assert_eq!(scan_zip(&forged, &small), Err(codes::EXPANDS_TOO_FAR));
    assert_eq!(scan_zip(&forged, &CAPS), Err(codes::CORRUPT));
}

#[test]
fn entry_floods_zip64_encryption_and_other_methods_are_refused() {
    let many: Vec<_> = (0..20).map(|_| ("a", 0u16, Vec::new(), 0u32)).collect();
    let few = WorkbookCaps {
        max_entries: 10,
        ..CAPS
    };
    assert_eq!(scan_zip(&zip(&many), &few), Err(codes::TOO_MANY_ENTRIES));
    assert!(scan_zip(&zip(&many), &CAPS).is_ok());
    let zip64 = zip(&[("a", 0, Vec::new(), u32::MAX)]);
    assert_eq!(scan_zip(&zip64, &CAPS), Err(codes::EXPANDS_TOO_FAR));
    let mut encrypted = zip(&[("a", 0, b"x".to_vec(), 1)]);
    let cd = encrypted.len() - 22 - 47;
    encrypted[cd + 8] = 1;
    assert_eq!(scan_zip(&encrypted, &CAPS), Err(codes::CORRUPT));
    let bzip = zip(&[("a", 12, b"x".to_vec(), 1)]);
    assert_eq!(scan_zip(&bzip, &CAPS), Err(codes::CORRUPT));
    assert_eq!(
        scan_zip(b"PK\x03\x04 not a zip", &CAPS),
        Err(codes::CORRUPT)
    );
}

#[test]
fn the_whole_sheet_box_and_the_cell_count_are_capped() {
    let budget = CellBudget::new(CAPS);
    // A1 + XFD1048576: two cells, a 1,048,576 × 16,384 box.
    assert_eq!(
        budget.check_box(1_048_576, 16_384),
        Err(codes::GRID_TOO_LARGE)
    );
    assert_eq!(budget.check_box(50_000, 100), Ok(()));
    let mut budget = CellBudget::new(WorkbookCaps {
        max_cells: 3,
        ..CAPS
    });
    assert!((0..3).all(|_| budget.count().is_ok()));
    assert_eq!(budget.count(), Err(codes::TOO_MANY_CELLS));
}

#[test]
fn property_corrupted_containers_never_panic() {
    let books = reference_workbooks();
    let mut rng = Rng(0xA076_1D64_78BD_642F);
    for _ in 0..300 {
        let mut book = books[rng.below(2) as usize].clone();
        let tail = book.len().min(8_192) as u64;
        for _ in 0..1 + rng.below(8) {
            let at = book.len() - 1 - rng.below(tail) as usize;
            book[at] = rng.next() as u8;
        }
        let cut = book.len() - rng.below(64) as usize;
        let _ = scan_zip(&book[..cut], &CAPS);
    }
}
