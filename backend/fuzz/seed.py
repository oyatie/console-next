#!/usr/bin/env python3
"""Write the synthesized seed corpora (corpus/<target>/seed-*). Every value is made up:
RRNs, 사업자등록번호 and phone numbers are shaped like real ones but belong to nobody.
Re-run after changing a target's input format; the seeds are committed, the rest of
corpus/ is libFuzzer's working set (gitignored)."""
import io, json, pathlib, zipfile

ROOT = pathlib.Path(__file__).resolve().parent / "corpus"

def put(target, items):
    d = ROOT / target
    d.mkdir(parents=True, exist_ok=True)
    for old in d.glob("seed-*"):
        old.unlink()
    for i, data in enumerate(items):
        (d / f"seed-{i:03d}").write_bytes(data if isinstance(data, bytes) else data.encode())

def col(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

def xlsx(sheets, dates=False, stored=False, dim=None):
    """A minimal workbook: inline strings, numbers, and (dates=True) a date-styled column."""
    buf = io.BytesIO()
    z = zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED)
    put_entry = z.writestr
    z.writestr = lambda name, data: put_entry(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), data, z.compression)
    ws = "".join(f'<Override PartName="/xl/worksheets/sheet{i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(len(sheets)))
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + ws + "</Types>")
    z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    names = "".join(f'<sheet name="{n}" sheetId="{i+1}" r:id="rId{i+1}"/>' for i, (n, _) in enumerate(sheets))
    z.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names + "</sheets></workbook>")
    rels = "".join(f'<Relationship Id="rId{i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i+1}.xml"/>' for i in range(len(sheets)))
    rels += f'<Relationship Id="rId{len(sheets)+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + "</Relationships>")
    z.writestr("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>')
    for i, (_, rows) in enumerate(sheets):
        out = []
        for r, row in enumerate(rows):
            cells = []
            for c, v in enumerate(row):
                ref = f"{col(c)}{r+1}"
                if v is None:
                    continue
                if isinstance(v, (int, float)):
                    style = ' s="1"' if dates and isinstance(v, int) and 30000 < v < 60000 else ""
                    cells.append(f'<c r="{ref}"{style}><v>{v}</v></c>')
                else:
                    t = str(v).replace("&", "&amp;").replace("<", "&lt;")
                    cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{t}</t></is></c>')
            out.append(f'<row r="{r+1}">' + "".join(cells) + "</row>")
        dim = dim or (f"A1:{col(max(len(r) for r in rows) - 1)}{len(rows)}" if rows else "A1")
        z.writestr(f"xl/worksheets/sheet{i+1}.xml", '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="' + dim + '"/><sheetData>' + "".join(out) + "</sheetData></worksheet>")
    z.close()
    return buf.getvalue()

# FZ-5: a <dimension> whose end is before its start underflows in calamine's get_dimension. Kept in
# regressions/ (the pinned test reads it), not in the seeds: while FZ-5 is open every run would stop on it.
REVERSED = None  # set below, once xlsx() exists

ROSTER = [
    ["직원 명부 (예시)"],
    [],
    ["사번", "성명", "입사일", "주민등록번호", "휴대전화", "부서", "직위", "재직상태"],
    ["1001", "김가상", 45292, "900101-1000001", "010-0000-0001", "본사 인사팀", "대리", "재직"],
    [1002, "이예시", "2024-03-02", "0001013000002", "+82 10 0000 0002", "물류센터", "사원", "휴직"],
    ["A-003", "박테스트", "2023.12.31", 101013000003, "01000000003", "", "과장", "퇴직"],
]
REVERSED = xlsx([("Sheet1", [["성명"], ["가"]])], dim="B2:A1")
REG = ROOT.parent / "regressions"
REG.mkdir(exist_ok=True)
(REG / "fz5-reversed-dimension.xlsx").write_bytes(REVERSED)
put("xlsx-read", [
    xlsx([("명부", ROSTER)], dates=True),
    xlsx([("Sheet1", [["성명", "사번"], ["홍길동", 1.0]])], stored=True),
    xlsx([("a", []), ("b", [["이름", "입사일자"], ["가", 45000]])], dates=True),
    b"PK\x03\x04",
    b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64,   # OLE (protected / legacy .xls)
])

CELLS = ["2024-01-02", "2024.1.2", "2024/01/02", "20240102", "45292", "2024-02-30", "+000-+1-+1",
         "900101-1000001", "9001011000001", "1013000003", "101013000003.0", "000101-3000002",
         "aaaaa가bbbbb", "１２３-４５-６７８９０", "재직", "휴직", "퇴직", "사번", " 성 명 ", "입사일자",
         "주민등록번호", "휴대전화", "AA", "XFD", "ZZZZ", "", "​사번", "=cmd|' /C calc'!A0"]
put("import-cells", CELLS)

IDS = ["123-45-67890", "1234567890", "１２３４５６７８９０", "0000", "000111-1234560", "0001111234560",
       "12345678901", "123-45-67890-1", "010-1234-5678", "+82 10 1234 5678", "02-123-4567",
       "1588-0000", "O1O-1234-5678", "a@b.example", "ops@예시.kr", " 010 1234 5678 "]
put("kr-ids", IDS)

def patch(ops, current):
    return json.dumps(ops, ensure_ascii=False) + "\0" + json.dumps(current, ensure_ascii=False)
CUR = {"name": "김가상", "phone": "+821000000001", "phone_rev": 3, "dept": {"id": "d1", "name": "인사팀"}, "n": 1.0}
put("json-patch", [
    patch([{"op": "test", "path": "/name", "value": "김가상"}, {"op": "replace", "path": "/name", "value": "김변경"}], CUR),
    patch([{"op": "replace", "path": "/name", "value": "x"}], CUR),
    patch([{"op": "test", "path": "/phone_rev", "value": 3}, {"op": "replace", "path": "/phone", "value": "+821000000009"}], CUR),
    patch([{"op": "test", "path": "/dept", "value": {"id": "d1", "name": "인사팀"}}, {"op": "move", "from": "/dept/name", "path": "/dept/label"}], CUR),
    patch([{"op": "test", "path": "/n", "value": 1}], CUR),
    patch([{"path": "/state", "value": "PENDING"}], {"state": "PENDING"}),
    patch([{"op": "test", "path": "/a~1b", "value": None}, {"op": "remove", "path": "/a~1b"}], {"a/b": None}),
])

LE = {"biz_kind": "CORPORATION", "name": "주식회사 가상", "crn": "000111-1234560", "representation_mode": "SINGLE",
      "representatives": ["김가상"], "head_office_address": {"road": "서울특별시 중구 세종대로 1", "zip": "04524"},
      "incorporated_on": "2020-01-02", "fiscal_year_end_month": 12, "capital_won": 100000000, "main_phone": "02-000-0000"}
WP = {"name": "본사", "sub_serial": "0001", "opened_on": "2020-01-02", "address": {"road": "서울특별시 중구 세종대로 1"}}
# An individual business registration (BizKind::Individual), as the fixture register declares seed-004.
REG = {"brn": "000-45-00016", "trade_name": "가상", "opened_on": "2020-01-02", "nts_tax_type": "GENERAL"}
def body(pick, value):
    return bytes([pick]) + (value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode())
put("entity-bodies", [
    body(0x00 | 0x20, LE), body(0x00, {"biz_kind": "INDIVIDUAL", "name": "가상상회", "representation_mode": "JOINT", "representatives": ["가", "나"]}),
    body(0x09, LE), body(0x01 | 0x20, WP), body(0x02 | 0x20, REG), body(0x03, {"crn": "0001111234560", "reason": "TYPO"}),
    body(0x04, {"brn": "0004500087", "effective_on": "2026-10-07"}), body(0x05 | 0x30, {"basis": "CONTRACT", "until": "2027-01-01"}),
    body(0x06, b"CERTIFICATE\0cert.pdf\0%PDF-1.7\n"), body(0x07, b"HQ-01"), body(0x07, "물류 거점".encode()),
])

MAP = {"sheets": {"명부": {"header_row": 3, "columns": {"A": "employee_number", "B": "name", "C": "hire_date", "D": None}}, "x": {"skip": True}}}
GRID = "직원 명부\n\n사번\t성명\t입사일\t주민등록번호\n1001\t김가상\t2024-01-02\t900101-1000001\n1002\t이예시\t2024.03.02\t\n"
put("import-mapping", [
    json.dumps(MAP, ensure_ascii=False) + "\0" + GRID,
    "{}\0" + GRID,
    json.dumps({"sheets": {"s": {"columns": {"A": "name", "B": "name"}, "header_row": 1}}}) + "\0성명\t이름\n가\t나\n",
    json.dumps({"sheets": {"s": {"columns": {"ZZZZZZZ": "name"}}}}) + "\0a\n",
])
print("seeded", sum(1 for _ in ROOT.glob("*/seed-*")), "files")
