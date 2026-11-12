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
        let book = worksheet_zip("worksheets/sheet1.xml", "xl/worksheets/sheet1.xml", &xml);
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
        "<a:b:sheetData/><dimension ref='B2:A1'/><sheetData/>",
        "<!-- dimension --><dimension ref='A2:A1'/>",
        "<![CDATA[dimension]]><dimension ref='B1:A1'/>",
        "<?dimension?><dimension ref='B2:A1'/>",
        "<dimension ignored='>' ref='B2:A1'/>",
        "<dimension ignored=\"<sheetData/>\" ref='B2:A1'/>",
        "<dimension ref='A1' ref='B2'/>",
        "<dimension/>",
        "<dimension ref='A1&#58;B2'/>",
        "<!DOCTYPE worksheet><worksheet><sheetData/></worksheet>",
        "<!doctype worksheet [<!ELEMENT x ANY><sheetData>]><dimension ref='B2:A1'/>",
        "<!DocType w [<!ATTLIST w a CDATA #IMPLIED><sheetData/>]><dimension ref='B2:A1'/>",
        "<!dOcTyPe worksheet><dimension ref='A1'/><sheetData/>",
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

#[test]
fn markup_decoys_and_post_data_dimensions_preserve_valid_sheets() {
    for prefix in [
        "<!-- > ' <dimension ref='B2:A1'/> -->",
        "<![CDATA[> ' <dimension ref='B2:A1'/>]]>",
        "<?test > ' <dimension ref='B2:A1'/> ?>",
    ] {
        let xml = format!("{prefix}<worksheet><dimension ref='A1'/><sheetData/></worksheet>");
        assert_eq!(check(xml.as_bytes()), Ok(()), "{prefix}");
    }
    assert_eq!(
        check(b"<worksheet><dimension ref='A1'/><sheetData/><extLst><dimension ref='height'/></extLst></worksheet>"),
        Ok(())
    );
}

fn worksheet_zip(target: &str, name: &str, xml: &str) -> Vec<u8> {
    let workbook = "<workbook><sheets><sheet r:id='sheet'/></sheets></workbook>";
    let rels =
        format!("<Relationships><Relationship Id='sheet' Target='{target}'/></Relationships>");
    zip(&[
        (
            "xl/workbook.xml",
            0,
            workbook.as_bytes().to_vec(),
            workbook.len() as u32,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            0,
            rels.as_bytes().to_vec(),
            rels.len() as u32,
        ),
        (name, 0, xml.as_bytes().to_vec(), xml.len() as u32),
    ])
}

#[test]
fn declared_sheet_targets_are_checked_with_the_readers_path_rules() {
    for target in [
        "worksheets/renamed.xml",
        "xl/worksheets/renamed.xml",
        "/xl/worksheets/renamed.xml",
    ] {
        for name in [
            "xl/worksheets/renamed.xml",
            "XL/WORKSHEETS/RENAMED.XML",
            "xl\\worksheets\\renamed.xml",
        ] {
            let book = worksheet_zip(
                target,
                name,
                "<worksheet><dimension ref='B2:A1'/></worksheet>",
            );
            assert_eq!(
                check_dimensions(&book, &CAPS),
                Err(codes::CORRUPT),
                "{target}: {name}"
            );
        }
    }
}

#[test]
fn unrelated_xml_parts_do_not_trigger_dimension_refusals() {
    for book in [
        include_bytes!("../../../../../../app/src/hr/fixtures/dimension-svg.xlsx").as_slice(),
        include_bytes!("../../../../../../app/src/hr/fixtures/dimension-pivot.xlsx").as_slice(),
        include_bytes!("../../../../../../app/src/hr/fixtures/dimension-custom.xlsx").as_slice(),
    ] {
        assert_eq!(check_dimensions(book, &CAPS), Ok(()));
    }
}

#[test]
fn unreferenced_relationships_and_orphan_sheets_are_not_screened() {
    let workbook = "<workbook><sheets><w:sheet a:b:id='unused' z:id='live'/></sheets></workbook>";
    let rels = "<Relationships><!-- > <Relationship Id='live' Target='worksheets/orphan.xml'/> --><p:Relationship Target='/xl/worksheets/live.xml' Id='live'/><Relationship Id='unused' Target='worksheets/orphan.xml'/></Relationships>";
    let sheet = "<worksheet><dimension ref='A1'/><sheetData/></worksheet>";
    let orphan = "<!DOCTYPE worksheet><worksheet><dimension ref='B2:A1'/></worksheet>";
    let parts: Vec<_> = [
        ("xl/workbook.xml", workbook),
        ("xl/_rels/workbook.xml.rels", rels),
        ("xl/worksheets/live.xml", sheet),
        ("xl/worksheets/orphan.xml", orphan),
    ]
    .into_iter()
    .map(|(name, xml)| (name, 0, xml.as_bytes().to_vec(), xml.len() as u32))
    .collect();
    assert_eq!(check_dimensions(&zip(&parts), &CAPS), Ok(()));
}
