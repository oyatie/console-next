// SPDX-License-Identifier: LicenseRef-Proprietary

use super::{CAPS, check, check_dimensions, codes, zip};

#[test]
fn declared_encodings_cannot_change_which_worksheet_is_screened() {
    for book in [
        include_bytes!("../../../../../../app/src/hr/fixtures/dimension-encoding.xlsx").as_slice(),
        include_bytes!("../../../../../../app/src/hr/fixtures/dimension-encoding-late.xlsx")
            .as_slice(),
    ] {
        assert_eq!(check_dimensions(book, &CAPS), Err(codes::CORRUPT));
    }
    let control =
        include_bytes!("../../../../../../app/src/hr/fixtures/dimension-encoding-utf8.xlsx");
    assert_eq!(check_dimensions(control, &CAPS), Ok(()));
}

#[test]
fn every_screened_xml_part_requires_a_utf8_declaration() {
    for xml in [
        b"\xff\xfe<worksheet/>".as_slice(),
        b"<\0w\0o\0r\0k\0s\0h\0e\0e\0t\0/\0>\0".as_slice(),
    ] {
        assert_eq!(check(xml), Err(codes::CORRUPT));
    }
    for encoding in [
        "windows-1252",
        "UTF-16",
        "Shift_JIS",
        "ISO-2022-JP",
        "UTF-8",
        "utf8",
    ] {
        for changed in [
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/sheet.xml",
        ] {
            for position in [0, 1, 2] {
                let declaration = format!("<?xml version='1.0' encoding='{encoding}'?>");
                let parts: Vec<_> = [
                    ("xl/workbook.xml", "<workbook><sheet r:id='sheet'/></workbook>"),
                    ("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id='sheet' Target='sheet.xml'/></Relationships>"),
                    ("xl/sheet.xml", "<worksheet><dimension ref='A1'/><sheetData/></worksheet>"),
                ].into_iter().map(|(name, xml)| {
                    let mut xml = xml.to_owned();
                    if name == changed {
                        xml.insert_str(match position { 0 => 0, 1 => xml.find('>').unwrap() + 1, _ => xml.rfind("</").unwrap() }, &declaration);
                    }
                    (name, 0, xml.as_bytes().to_vec(), xml.len() as u32)
                }).collect();
                let expected = if ["UTF-8", "utf8"].contains(&encoding) {
                    Ok(())
                } else {
                    Err(codes::CORRUPT)
                };
                assert_eq!(
                    check_dimensions(&zip(&parts), &CAPS),
                    expected,
                    "{encoding}: {changed}: position={position}"
                );
            }
        }
    }
}

#[test]
fn worksheet_paths_are_screened_once_ignoring_case() {
    let workbook = "<workbook><sheet r:id='one'/><sheet r:id='two'/><sheet r:id='one'/></workbook>";
    let rels = "<Relationships><Relationship Id='one' Target='sheet.xml'/><Relationship Id='two' Target='SHEET.XML'/></Relationships>";
    let sheet = "<worksheet><dimension ref='A1'/><sheetData/></worksheet>";
    let parts: Vec<_> = [
        ("xl/workbook.xml", workbook),
        ("xl/_rels/workbook.xml.rels", rels),
        ("xl/sheet.xml", sheet),
    ]
    .into_iter()
    .map(|(name, xml)| (name, 0, xml.as_bytes().to_vec(), xml.len() as u32))
    .collect();
    super::super::dimension::CHECKS.set(0);
    assert_eq!(check_dimensions(&zip(&parts), &CAPS), Ok(()));
    assert_eq!(super::super::dimension::CHECKS.get(), 1);
}
