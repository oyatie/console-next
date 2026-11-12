// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use super::dimension::check;
use super::tests::{CAPS, zip};
use super::zip::{check_dimensions, scan_zip};
use super::{WorkbookCaps, codes};

#[test]
fn invalid_dimensions_are_corrupt_before_the_library_reads_them() {
    for dimension in [
        "XFE1",
        "A1048577",
        "B2:A1",
        "A2:A1",
        "B1:A1",
        "A0",
        "0",
        "A",
        "1",
        "",
        "A1:B2:C3",
        "A1:",
        ":A1",
        "A4294967296",
        "ZZZZZZZZZZ1",
        "A1:A0",
        "A1:1",
        "$A$1",
        "A1:B0",
    ] {
        let xml = format!("<worksheet><dimension ref=\"{dimension}\"/><sheetData/></worksheet>");
        let book = zip(&[("sheet.xml", 0, xml.as_bytes().to_vec(), xml.len() as u32)]);
        assert!(scan_zip(&book, &CAPS).is_ok());
        assert_eq!(
            check_dimensions(&book, &CAPS),
            Err(codes::CORRUPT),
            "{dimension}"
        );
    }
}

#[test]
fn valid_dimensions_and_xml_text_do_not_trigger_a_refusal() {
    for xml in [
        "<worksheet><dimension ref='A1'/><sheetData/></worksheet>",
        "<worksheet><s:dimension other='>' ref = 'a1:b2'></s:dimension><sheetData/></worksheet>",
        "<worksheet><dimension ref='XFD1048576'/><sheetData/></worksheet>",
        "<worksheet><dimension ref='A1:XFD1048576'/><sheetData/></worksheet>",
        "<worksheet><sheetData/></worksheet>",
        "<!-- <dimension ref='B2:A1'/> --><worksheet><sheetData/></worksheet>",
        "<?test <dimension ref='B2:A1'/> ?><worksheet><sheetData/></worksheet>",
        "<![CDATA[<dimension ref='B2:A1'/>]]><worksheet><sheetData/></worksheet>",
        "<worksheet><sheetData><row><c><is><t>&lt;dimension ref='B2:A1'/&gt;</t></is></c></row></sheetData></worksheet>",
    ] {
        assert_eq!(check(xml.as_bytes()), Ok(()), "{xml}");
    }
}

#[test]
fn namespace_attributes_and_markup_do_not_bypass_dimension_validation() {
    for xml in [
        "<s:dimension ref='B2:A1'/>",
        "<!-- dimension --><dimension ref='A2:A1'/>",
        "<![CDATA[dimension]]><dimension ref='B1:A1'/>",
        "<?dimension?><dimension ref='B2:A1'/>",
        "<dimension ignored='>' ref='B2:A1'/>",
        "<dimension ignored=\"<sheetData/>\" ref='B2:A1'/>",
        "<dimension ref='A1' ref='B2'/>",
        "<dimension/>",
        "<dimension ref='A1&#58;B2'/>",
        "<!DOCTYPE worksheet><worksheet><sheetData/></worksheet>",
    ] {
        assert_eq!(check(xml.as_bytes()), Err(codes::CORRUPT), "{xml}");
    }
}

#[test]
fn compressed_regression_is_refused_and_container_caps_still_apply() {
    let book = include_bytes!("../../../../../../fuzz/regressions/fz5-reversed-dimension.xlsx");
    assert_eq!(check_dimensions(book, &CAPS), Err(codes::CORRUPT));
    let caps = WorkbookCaps {
        max_expanded_bytes: 1,
        ..CAPS
    };
    assert_eq!(check_dimensions(book, &caps), Err(codes::EXPANDS_TOO_FAR));
}
