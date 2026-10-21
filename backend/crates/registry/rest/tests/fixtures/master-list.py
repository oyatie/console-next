#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Generates master-list.xlsx, the registry import fixture, from nothing but the importer's layout.

Every value is synthetic (DECISIONS L4-F1): no cell, sheet name or document property comes from a customer workbook.
The layout is the one console-registry-adapter-postgres parses (parse_master_row, parse_reserve_row); the values are
the ones the registry tests assert (row 4 is CFB30-0001, management no. 290 has model TEST-25, the reserve sheet
holds CFO25-0445 with no residual value; 444 master rows + 1 reserve row).

    python3 backend/crates/registry/rest/tests/fixtures/master-list.py   # rewrites master-list.xlsx beside it
"""
import pathlib
import zipfile
from xml.sax.saxutils import escape

MASTER = "가상물류 지게차 Master list"  # "<company> 지게차 Master list" (ImportSheet::Master)
RESERVE = "예비 및 여유차량"  # ImportSheet::Reserve


def col(n):
    return chr(ord("A") + n - 1)


def sheet(rows):
    out = []
    for r, cells in rows:
        cs = "".join(f'<c r="{col(c)}{r}" t="inlineStr"><is><t>{escape(v)}</t></is></c>' for c, v in sorted(cells.items()))
        out.append(f'<row r="{r}">{cs}</row>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<sheetData>{"".join(out)}</sheetData></worksheet>')


def master_rows():
    for r in range(4, 448):
        n = r - 3
        power, ton = ("B", "30") if n == 1 else ("O", "25")
        # B 관리번호 = 호기, C 제조, D 동력, E 종류, F 장비 No, G 사업장, H 고객, I 상태, N 규격, O 톤수, Q 모델
        yield r, {2: f"{n:03}", 3: "C", 4: power, 5: "F", 6: f"CF{power}{ton}-{n:04}", 7: "테스트 현장",
                  8: "테스트 고객", 9: "임대", 14: "좌식", 15: f"{ton[0]}.{ton[1]}T", 17: f"TEST-{ton}"}


def reserve_rows():
    # B 동력, C 장비 No, D 사업장, E 상태, I 규격, J 톤수, L 모델; no 잔존가 (U)
    yield 5, {2: "O", 3: "CFO25-0445", 4: "테스트 현장", 5: "예비", 9: "좌식", 10: "2.5T", 12: "TEST-25"}


NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml"
PARTS = {
    "[Content_Types].xml": (
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f'<Override PartName="/xl/workbook.xml" ContentType="{NS_CT}.sheet.main+xml"/>'
        f'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="{NS_CT}.worksheet+xml"/>'
        f'<Override PartName="/xl/worksheets/sheet2.xml" ContentType="{NS_CT}.worksheet+xml"/></Types>'),
    "_rels/.rels": (
        f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{NS_REL}">'
        f'<Relationship Id="rId1" Type="{NS_DOC}/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": (
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'xmlns:r="{NS_DOC}"><sheets><sheet name="{MASTER}" sheetId="1" r:id="rId1"/>'
        f'<sheet name="{RESERVE}" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": (
        f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{NS_REL}">'
        f'<Relationship Id="rId1" Type="{NS_DOC}/worksheet" Target="worksheets/sheet1.xml"/>'
        f'<Relationship Id="rId2" Type="{NS_DOC}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": sheet(master_rows()),
    "xl/worksheets/sheet2.xml": sheet(reserve_rows()),
}

if __name__ == "__main__":
    out = pathlib.Path(__file__).with_name("master-list.xlsx")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in PARTS.items():  # fixed timestamps: the same script writes the same bytes
            z.writestr(zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)), text.encode(), zipfile.ZIP_DEFLATED)
    print(f"wrote {out}")
