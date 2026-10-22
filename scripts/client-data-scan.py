#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Structural client-data scanner.

    client-data-scan.py [--root DIR] --staged              added lines in the index
    client-data-scan.py [--root DIR] --message FILE        a commit message
    client-data-scan.py [--root DIR] --tree [PATH...]      tracked working-tree files
    client-data-scan.py [--root DIR] --range REV...        added lines and messages in revisions
    client-data-scan.py [--root DIR] --branch              commits on HEAD absent from trunk
    client-data-scan.py [--root DIR] --history [REV...]    history; --all or --tags checks every ref/tag

The scanner has no term-list input. It checks checksum-valid RRN with a plausible birth date, dashed CRN, BRN outside
the synthetic range (undashed BRN only on a labeled line), labeled 10-16 digit account numbers, mobile numbers
outside placeholder patterns, e-mail addresses outside reserved/example domains, local paths, and binary/office-file
structure. Undashed RRN/CRN/BRN inside HTTP(S) links are treated as IDs; dashed identifiers and mobile numbers in
links remain findings. Text is decoded as UTF-8, UTF-16 (BOM), or CP949. Office XML, relationships, attributes, and
member names are checked. Media files are counted without reading their bytes; other unreadable content is reported
as binary unless a reviewed `binary` path allows it.

`.client-data-allow` accepts `path`, `binary`, `value`, `email`, and `clean` entries, each followed by ` -- reason`.
Legacy `term` entries are ignored and reported; they do not affect structural scanning. `path` and `binary` globs
silence structural rules and binary classification in their paths. `value` entries allow one known synthetic
structural value by its 12-hex digest; `email` accepts an address or domain (including subdomains); `clean` marks a
full trunk commit already scanned by `--history` (a branch commit is refused).

Text and names with structural hits are never printed; hit names show as `<path>`. Output includes structural rules
and line numbers. History is limited by the repository's clean point unless `--all` or explicit revisions are used.
Exit: 0 clean, 1 findings, 2 incomplete scan or bad config.
"""
import argparse, bisect, collections, concurrent.futures, fnmatch, hashlib, html, io, itertools, json, os, re, sqlite3, subprocess, sys, tempfile, unicodedata, urllib.parse, zipfile
from pathlib import Path
import stat

SYNTHETIC_RANGES = json.loads(Path(__file__).with_name("fixture-synthetic-ranges.json").read_text())

OFFICE = (".xlsx", ".xlsm", ".docx", ".pptx", ".odt", ".ods", ".odp", ".hwpx")
OFFICE_EXT = {x[1:] for x in OFFICE}
MEDIA = set("png jpg jpeg gif webp ico bmp tif tiff avif heic icns woff woff2 ttf otf eot mp3 mp4 m4a wav ogg webm "
            "mov avi wasm".split())  # unreadable without non-stdlib tools: counted, never green-by-silence
EMAIL = re.compile(r"(?<![\w.%+-])[a-z0-9][a-z0-9._%+-]*@((?:[a-z0-9-]+\.)+[a-z]{2,24})(?![\w-])", re.I)
FILE_TLD = set("png jpg jpeg gif svg webp ico js mjs cjs ts tsx jsx css scss json md html rs py sh txt lock yml yaml "
               "toml wasm map woff woff2 ttf otf pdf zip gz tar sql csv xml".split())
SAFE_DOMAIN = re.compile(r"(^|\.)(example|test|invalid|localhost|local)$|(^|\.)example\.[a-z.]+$"
                         r"|(^|\.)(users\.noreply\.github\.com|openssh\.com|libssh\.org)$"  # last two: algorithm names
                         r"|^(acme|contoso|fabrikam|ganada|corp|company|partner|email|domain|sample|foo|bar)"
                         r"\.([a-z]{2,3}|co\.kr|or\.kr)$")  # placeholder domains: acme.co.kr, corp.com
RRN = re.compile(r"(?<![\w%-])(\d{2})(\d{2})(\d{2})( ?- ?|)([1-8]\d{6})(?![\w-])")
BRN = re.compile(r"(?<![\w%+-])(\d{3})(-?)(\d{2})\2(\d{5})(?![\w-])")  # dashed or undashed
# Ten bare digits are also region codes (법정동/행정동), timestamps and phone numbers: undashed counts as a BRN only on a
# line that names one (a key, a label, a function).
BRN_WORD = re.compile(r"사업자|등록\s*번호|brn|bizno|biz_?(?:no|num|reg)|business|tax_?id|corp_?(?:no|num)", re.I)
# Account formats have no common checksum, so require a field label before 10-16 digits.
ACCOUNT = re.compile(
    r"(?i)(?:\baccount(?:[\s_-]*(?:number|no|num|id))?\b|\bacct(?:[\s_-]*(?:number|no|num|id))?\b"
    r"|계좌(?:\s*번호)?|통장(?:\s*번호)?)\s*[:=#]?\s*(\d(?:[ -]?\d){8,14}\d)(?![\w])")
URL = re.compile(r"https?://[^\s\"'<>,;|{}\[\]()`]+")  # a link ends at a quote, comma, bracket: JSON, CSV
# Mobile: 010-1234-5678, 010 1234 5678, 010 1234-5678, 01012345678, (010)1234-5678, +82 10-1234-5678, +82 (0)10...,
# 82-10-...: '-', '.', and spaces; spaces around punctuation and repeated spaces are accepted too.
PHONE_SEP = r"(?:[ .]*[-.][ .]*|[ .]+)?"
PHONE = re.compile(rf"(?<![\w%+-])(?:(?:\+|00)?82{PHONE_SEP}(?:\(0\)|0)?|\(0|0)1[016789]\)?{PHONE_SEP}(\d{{3,4}}){PHONE_SEP}(\d{{4}})(?![\w-])")
# Dashes and middle dots NFKC keeps (U+2010-2015, U+2212, U+00B7, U+2027, U+30FB): a number written with them is a '-'.
DASH = str.maketrans(dict.fromkeys("\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u00b7\u2027\u30fb", "-"))
TAG = re.compile(r"<[^<>]{0,200}>")
AT = re.compile(r"\s*[\[(]\s*(at|dot)\s*[\])]\s*", re.I)  # kim [at] corp [dot] kr; never {at}: a template slot


def value_key(value):
    normalized = re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", value).casefold())
    return hashlib.sha256(normalized.encode()).hexdigest()[:12]


def _esc(s):
    """JSON/JS escapes: \\uXXXX, \\u{X...}, and runs of \\xNN read as UTF-8 bytes."""
    s = re.sub(r"\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})",
               lambda m: chr(min(int(m.group(1) or m.group(2), 16), 0x10FFFF)), s)
    return re.sub(r"(?:\\x[0-9a-fA-F]{2})+",
                  lambda m: bytes.fromhex(m.group(0).replace("\\x", "")).decode("utf-8", "replace"), s)


def _at(s):
    return AT.sub(lambda m: "@" if m.group(1).lower() == "at" else ".", s)


# Unescaped structural readings: trigger, transform, and whether the decoded view can produce findings.
VIEWS = (("\\", _esc, True), ("&", html.unescape, True), ("%", urllib.parse.unquote, True), (AT, _at, True))


def rrn_ok(d):
    s = sum(int(c) * w for c, w in zip(d, (2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5)))
    return (11 - s % 11) % 10 == int(d[12])


def crn_ok(d):
    s = sum(int(c) * (1 + i % 2) for i, c in enumerate(d[:12]))
    return (10 - s % 10) % 10 == int(d[12])


def brn_ok(d):
    s = sum(int(c) * w for c, w in zip(d, (1, 3, 7, 1, 3, 7, 1, 3, 5))) + int(d[8]) * 5 // 10
    return (10 - s % 10) % 10 == int(d[9])


def decode(blob):
    """Text of a blob, or None when it is binary."""
    if blob[:3] == b"\xef\xbb\xbf":
        return blob[3:].decode("utf-8", "replace")
    if blob[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return blob.decode("utf-16", "replace")
    if b"\0" in blob[:8192]:
        return None
    for enc in ("utf-8", "cp949"):  # Korean Excel exports CSV as CP949
        try:
            return blob.decode(enc)
        except UnicodeDecodeError:
            pass
    return blob.decode("utf-8", "replace")


# --- the repo allow-list ---------------------------------------------------------------------------------
class Allow:
    KINDS = ("path", "binary", "email", "value", "clean")

    def __init__(self, root, source="worktree"):
        self.ignored_terms = 0
        self.paths, self.binaries, self.emails, self.values, self.clean = [], [], set(), set(), []
        self.email_hashes = set()
        p = Path(root) / ".client-data-allow"
        if source == "worktree":
            try:
                if not stat.S_ISREG(p.stat().st_mode):
                    print(f"client-data-scan: NOT CHECKED: {p}: allow file is not a regular file", file=sys.stderr)
                    sys.exit(2)
            except FileNotFoundError:
                return
            except OSError as e:
                print(f"client-data-scan: NOT CHECKED: {p}: {type(e).__name__}", file=sys.stderr)
                sys.exit(2)
            try:
                text = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as e:
                print(f"client-data-scan: NOT CHECKED: {p}: {type(e).__name__}", file=sys.stderr)
                sys.exit(2)
        else:
            entry = ":.client-data-allow" if source == "index" else f"{source}:.client-data-allow"
            data = git(root, "show", entry, check=False)
            if not data:
                return
            text = data.decode("utf-8")
        for i, line in enumerate(text.splitlines(), 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            entry, _, reason = line.partition(" -- ")
            parts = entry.split()
            if parts and parts[0] == "term":
                self.ignored_terms += 1
                continue
            ok = parts and parts[0] in self.KINDS and len(parts) == 2
            if not ok or not reason.strip():
                print(f"client-data-scan: NOT CHECKED: {p}:{i}: invalid allow entry", file=sys.stderr)
                sys.exit(2)
            k, x = parts[0], parts[1]
            if k == "clean" and not re.fullmatch(r"[0-9a-f]{40}", x):
                print(f"client-data-scan: NOT CHECKED: {p}:{i}: invalid clean commit id", file=sys.stderr)
                sys.exit(2)
            {"path": self.paths.append, "binary": self.binaries.append, "email": self.emails.add,
             "value": self.values.add, "clean": self.clean.append}[k](x if k in ("path", "binary") else x.lower())
        self.email_hashes = {hashlib.sha256(x.encode()).hexdigest() for x in self.emails}

    def path(self, p, globs=None):
        return any(fnmatch.fnmatch(p, g) for g in (self.paths if globs is None else globs))

    def email(self, addr, domain):
        labels = domain.split(".")
        return addr in self.emails or any("@" + ".".join(labels[i:]) in self.emails for i in range(len(labels) - 1))

    def value(self, v):  # a structural match allowed by its private value hash
        return value_key(v) in self.values

    def hit_allowed(self, meta):
        """Whether every value represented by a path-independent cached structural hit is allow-listed."""
        return bool(meta and meta["candidates"]) and all(
            any(v in self.values for v in candidate["values"])
            or any(v in self.email_hashes for v in candidate["emails"])
            for candidate in meta["candidates"])


# --- rules -----------------------------------------------------------------------------------------------
class Scanner:
    def __init__(self, allow):
        self.allow, self.path_findings = allow, {}

    def show(self, path):
        """Redact a file or office-member name when it contains a structural finding."""
        return "<path>" if self.path_hits(path) else path

    def path_hits(self, path):
        """Check names and their stem because identifiers may appear in file and office-member names."""
        if path not in self.path_findings:
            stem = re.sub(r"\.\w{1,5}$", "", path).replace("_", " ")
            self.path_findings[path] = sorted({rule for _, rule in self.text(path + "\n" + stem)})
        return self.path_findings[path]

    def text(self, text, structural=True):
        """Yield structural findings as (line number, rule)."""
        yield from self._text(text, structural, False)

    def text_details(self, text, structural=True):
        """Yield path-independent findings with only hashes for structural values."""
        grouped = collections.OrderedDict()
        for no, rule, meta in self._text(text, structural, True):
            candidates = grouped.setdefault((no, rule), [])
            if meta:
                for candidate in meta["candidates"]:
                    if candidate not in candidates:
                        candidates.append(candidate)
        for (no, rule), candidates in grouped.items():
            yield no, rule, {"candidates": candidates} if candidates else None

    def _text(self, text, structural, details):
        seen = set()
        yield from self._view(text, structural, None, seen, details)
        lines = None
        for trigger, fn, view_structural in VIEWS:
            has = trigger.search if isinstance(trigger, re.Pattern) else (lambda s, t=trigger: t in s)
            if has(text):
                lines = lines or text.split("\n")
                idx = [i for i, ln in enumerate(lines) if has(ln)]
                alt = [fn(lines[i]).replace("\n", " ") for i in idx]
                if any(a != lines[i] for a, i in zip(alt, idx)):
                    yield from self._view("\n".join(alt), structural and view_structural, idx, seen, details)

    def _view(self, v, structural, idx, seen, details=False):
        low = v.lower() if v.isascii() else unicodedata.normalize("NFKC", v).casefold()
        newlines = None

        def line_number(pos):
            nonlocal newlines
            if newlines is None:
                newlines = [m.start() for m in re.finditer("\n", low)]
            line = bisect.bisect(newlines, pos)
            return idx[line] + 1 if idx else line + 1

        urls = [u.span() for u in URL.finditer(low)] if structural else []
        # Undashed IDs in HTTP(S) links are exempt; dashed IDs and mobile numbers are still checked.
        in_url = lambda m: "-" not in m.group(0) and any(a <= m.start() < b for a, b in urls)  # noqa: E731
        if structural:
            for finding in self.structural(low.translate(DASH), in_url, details):
                match, rule = finding[:2]
                meta = finding[2] if details else None
                no = line_number(match.start())
                seen_key = (no, rule, json.dumps(meta, sort_keys=True)) if details else (no, rule)
                if seen_key not in seen:
                    seen.add(seen_key)
                    yield (no, rule, meta) if details else (no, rule)

    def structural(self, low, in_url, details=False):
        def finding(match, rule, value, email_keys=()):
            if not details:
                return match, rule
            return match, rule, {"candidates": [{"values": [value_key(value)], "emails": list(email_keys)}]}

        for m in RRN.finditer(low):
            d = "".join(m.group(1, 2, 3, 5))
            if in_url(m) or (self.allow.value(d) and not details):
                continue
            if 1 <= int(m.group(2)) <= 12 and 1 <= int(m.group(3)) <= 31 and rrn_ok(d):
                yield finding(m, "rrn", d)
            elif m.group(4) and not d.startswith(SYNTHETIC_RANGES["businessPrefix"]) and crn_ok(d):
                yield finding(m, "crn", d)
        for m in BRN.finditer(low):
            d = m.group(1) + m.group(3) + m.group(4)
            if m.group(1) == SYNTHETIC_RANGES["businessPrefix"]:
                continue
            if not m.group(2) and not BRN_WORD.search(low, low.rfind("\n", 0, m.start()) + 1,
                                                      (low.find("\n", m.end()) + 1 or len(low) + 1) - 1):
                continue
            if (100 <= int(m.group(1)) <= 899 and brn_ok(d) and not in_url(m)
                    and (details or not self.allow.value(d))):
                yield finding(m, "brn", d)
        for m in ACCOUNT.finditer(low):
            d = re.sub(r"\D", "", m.group(1))
            if not (self.allow.value(d) and not details):
                yield finding(m, "account", d)
        for m in PHONE.finditer(low):
            mid, end = m.groups()
            d = re.sub(r"\D", "", m.group(0))
            d = d.lstrip("0")  # 0082 10..., +82 10... and 82 (0)10... are 010...: one allow hash
            d = "0" + (d[2:] if d.startswith("82") else d).lstrip("0")
            if (len(set(mid)) == 1 or len(set(end)) == 1 or mid in SYNTHETIC_RANGES["phoneMiddle"]
                    or (self.allow.value(d) and not details)):
                continue  # placeholders: 010-1234-xxxx, 010-123-xxxx, a group of one digit (010-0000-xxxx, 010-1111-2222)
            yield finding(m, "phone", d)
        for m in EMAIL.finditer(low):
            dom, addr = m.group(1), m.group(0)
            if not (dom.rsplit(".", 1)[1] in FILE_TLD or SAFE_DOMAIN.search(dom) or addr.startswith("git@")
                    or ((self.allow.email(addr, dom) or self.allow.value(addr)) and not details)):
                labels = dom.split(".")
                candidates = [addr] + ["@" + ".".join(labels[i:]) for i in range(len(labels) - 1)]
                email_keys = [hashlib.sha256(candidate.encode()).hexdigest() for candidate in candidates]
                yield finding(m, "email", addr, email_keys)


CELL_END = re.compile(r"</(?:si|c|row|w:p|a:p|hp:p|text:p|text:h)>")
ATTR = re.compile(r"=\s*\"([^\"]*)\"|=\s*'([^']*)'")
# A link to a file on the author's machine (an external workbook, a linked picture) names that machine's user.
LOCAL_PATH = re.compile(r"[Ff][Ii][Ll][Ee]:/|(?<![\w])[A-Za-z]:\\|/Users/|/home/")


def _tag(m):  # a tag becomes its attribute values: relationship targets, external-link paths, alt text
    return " " + " ".join(html.unescape(a or b) for a, b in ATTR.findall(m.group(0))) + " "


def _zname(i):
    """A member name; one stored without the UTF-8 flag was read as CP437 (Korean tools write CP949)."""
    if i.flag_bits & 0x800:
        return i.filename
    try:
        raw = i.filename.encode("cp437")
    except UnicodeEncodeError:
        return i.filename
    for enc in ("utf-8", "cp949"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return i.filename


def office_parts(blob):
    """[(member, bytes)] of an office file (a zip), or None when it is not one."""
    try:
        z = zipfile.ZipFile(io.BytesIO(blob))
        return [(_zname(i), z.read(i)) for i in z.infolist() if not i.is_dir()]
    except (zipfile.BadZipFile, OSError, RuntimeError, ValueError):
        return None


ZIP_MAGIC = b"PK\x03\x04"
OLE_MAGIC = b"\xd0\xcf\x11\xe0"


def container_kind(blob):
    if blob.startswith(ZIP_MAGIC):
        return "zip"
    if blob.startswith(OLE_MAGIC):
        return "ole"
    return None


def git(root, *args, check=True, stdin=None):
    # The user's diff prefixes, quoting, textconv and colour must not change what the parser reads.
    try:
        r = subprocess.run(["git", "-C", root, "-c", "core.quotePath=false", "-c", "diff.noprefix=false",
                            "-c", "diff.mnemonicPrefix=false", "-c", "color.ui=never", *args], capture_output=True,
                           check=False, input=stdin)
    except OSError as e:
        print(f"client-data-scan: NOT CHECKED: {root}: git {args[0] if args else '<unknown>'} failed: {type(e).__name__}",
              file=sys.stderr)
        sys.exit(2)
    if check and r.returncode:
        detail = r.stderr.decode(errors="replace").strip()
        print(f"client-data-scan: NOT CHECKED: {root}: git {args[0]} failed (exit {r.returncode})"
              + (f": {detail}" if detail else ""), file=sys.stderr)
        sys.exit(2)
    return r.stdout


DIFF = ("-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/")


# What a media file starts with: (offset, bytes) alternatives. Anything else under a media name is not media.
FTYP = [(4, b"ftyp"), (4, b"moov"), (4, b"wide"), (4, b"mdat"), (4, b"free"), (4, b"skip")]
MAGIC = {"png": [(0, b"\x89PNG")], "jpg": [(0, b"\xff\xd8\xff")], "gif": [(0, b"GIF8")], "webp": [(8, b"WEBP")],
         "ico": [(0, b"\0\0\1\0"), (0, b"\0\0\2\0")], "bmp": [(0, b"BM")], "tif": [(0, b"II*\0"), (0, b"MM\0*")],
         "icns": [(0, b"icns")], "woff": [(0, b"wOFF")], "woff2": [(0, b"wOF2")], "eot": [(34, b"LP")],
         "ttf": [(0, b"\0\1\0\0"), (0, b"true"), (0, b"OTTO")], "mp3": [(0, b"ID3"), (0, b"\xff\xfb"), (0, b"\xff\xf3"), (0, b"\xff\xf2")],
         "wav": [(8, b"WAVE")], "avi": [(8, b"AVI ")], "ogg": [(0, b"OggS")], "webm": [(0, b"\x1a\x45\xdf\xa3")],
         "wasm": [(0, b"\0asm")], "mp4": FTYP, "m4a": FTYP, "mov": FTYP, "heic": FTYP, "avif": FTYP}
MAGIC.update(jpeg=MAGIC["jpg"], tiff=MAGIC["tif"], otf=MAGIC["ttf"])


def is_media(blob):  # any known media signature: a JPEG saved as .png is still a picture
    return any(blob[o:o + len(b)] == b for sigs in MAGIC.values() for o, b in sigs)


def blob_hits(sc, path, blob, counts):
    """Hits in one whole file (and its name)."""
    yield from ((path, 0, r) for r in sc.path_hits(path))
    ext = path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
    if ext in MEDIA and is_media(blob):
        counts["images/fonts/media not read"] += 1
        return
    kind = container_kind(blob)
    parts = office_parts(blob) if kind == "zip" or "." + ext in OFFICE else None
    if parts is not None:  # every member: XML, relationships, VML; a picture or binary part cannot be read
        for member, data in parts:  # where: path NUL member (a path may hold '!'); main prints path!member
            where, text, pic = f"{path}\0{member}", decode(data), member.rsplit(".", 1)[-1].lower() in MEDIA
            yield from ((where, 0, r) for r in sc.path_hits(member))  # xl/media/<name>.png names the client too
            if text is None or pic:
                raw = text if text is not None else data.decode("utf-8", "replace")
                yield from ((where, no, r) for no, r in sc.text(raw, structural=False))
                if sc.allow.path(path) or sc.allow.path(path, sc.allow.binaries):
                    counts["binaries allow-listed"] += 1
                else:  # a photo, a signature, a nameplate in a document is client data until reviewed
                    yield where, 0, "office-media" if pic else "binary"
                continue
            for i, cell in enumerate(CELL_END.split(text), 1):  # line = cell or paragraph number
                cell = TAG.sub(_tag, cell)
                if LOCAL_PATH.search(cell):
                    yield where, i, "local-path"
                yield from ((where, i, r) for _, r in sc.text(cell))
        return
    if kind is not None:
        if sc.allow.path(path) or sc.allow.path(path, sc.allow.binaries):
            counts["binaries allow-listed"] += 1
        else:
            yield path, 0, "binary"
        return
    text = decode(blob)
    if text is not None:
        yield from ((path, no, r) for no, r in sc.text(text))
    else:
        yield from ((path, no, r) for no, r in sc.text(blob.decode("utf-8", "replace"), structural=False))
        if ext in MEDIA and is_media(blob):
            counts["images/fonts/media not read"] += 1
        elif sc.allow.path(path) or sc.allow.path(path, sc.allow.binaries):
            counts["binaries allow-listed"] += 1
        else:
            yield path, 0, "binary"  # unreadable (or not the media its name says): review it, then 'binary <glob> -- reason'


def unquote(p):
    """A path as git prints it: C-quoted when it holds '"', '\\' or control characters."""
    if not p.startswith('"'):
        return p
    b, i, s = bytearray(), 1, p.encode("utf-8", "surrogateescape")
    esc = {ord("n"): 10, ord("t"): 9, ord("r"): 13, ord("a"): 7, ord("b"): 8, ord("f"): 12, ord("v"): 11}
    while i < len(s) and s[i] != ord('"'):
        if s[i] == ord("\\"):
            if s[i + 1:i + 4].isdigit():
                b.append(int(s[i + 1:i + 4], 8))
                i += 4
                continue
            b.append(esc.get(s[i + 1], s[i + 1]))
            i += 2
            continue
        b.append(s[i])
        i += 1
    return b.decode("utf-8", "replace")


def diff_hits(sc, root, diff_args, counts, blob_of):
    """Added lines of a -U0 unified diff, read hunk by hunk from the @@ counts; binary files read whole."""
    path, old, new, no, prev, commit, block = None, 0, 0, 0, b"", "", []

    def flush():  # consecutive added lines are read as one text, so a name split across them still matches
        if block and path:
            text = "\n".join(decode(b) or b.decode("utf-8", "replace") for b in block)
            for i, r in sc.text(text):
                yield (f"{commit}:{path}" if commit else path), no - len(block) + i - 1, r
        block.clear()

    for raw in git(root, *diff_args).split(b"\n"):
        if old > 0 or new > 0:
            if raw[:1] == b"+":
                new, no = new - 1, no + 1
                block.append(raw[1:])
                if old <= 0 and new <= 0:
                    yield from flush()
                continue
            yield from flush()
            if raw[:1] == b"-":
                old -= 1
            elif raw[:1] == b" ":
                old, new, no = old - 1, new - 1, no + 1
            continue
        if raw.startswith(b"\0commit "):
            commit = raw.split()[1].decode()
        elif raw.startswith(b"diff --git "):
            path = None
        elif raw.startswith(b"+++ ") and prev.startswith(b"--- "):
            p = unquote(raw[4:].decode("utf-8", "surrogateescape").rstrip("\t"))
            path = p[2:] if p.startswith("b/") else None  # /dev/null: deleted
            if path:
                yield from ((f"{commit}:{path}" if commit else path, 0, r) for r in sc.path_hits(path))
        elif raw.startswith(b"@@ "):
            m = re.match(rb"@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", raw)
            old, no, new = int(m.group(1) or 1), int(m.group(2)), int(m.group(3) or 1)
        elif raw.startswith(b"Binary files ") and not raw.endswith(b" and /dev/null differ"):
            rest = raw[len(b"Binary files "):-len(b" differ")].decode("utf-8", "surrogateescape")
            # "/dev/null and b/P" (added) or "a/P and b/P" (--no-renames: both sides name the same path, maybe quoted)
            p = unquote(rest[len("/dev/null and "):] if rest.startswith("/dev/null and ") else rest[(len(rest) - 5) // 2 + 5:])
            p = p[2:] if p.startswith("b/") else p
            yield from ((f"{commit}:{w}" if commit else w, n, r) for w, n, r in blob_hits(sc, p, blob_of(commit, p), counts))
        prev = raw


def staged(sc, root, counts):
    yield from diff_hits(sc, root, ("diff", "--cached", *DIFF, "--diff-filter=ACMRT"), counts,
                         lambda _, p: git(root, "show", ":" + p))


def tracked_paths(root, paths):
    if not paths:
        return git(root, "ls-files", "-z").split(b"\0")
    found = set()
    for start in range(0, len(paths), 128):  # keep argv below the platform limit on a whole-tree request
        batch = paths[start:start + 128]
        found.update(p for p in git(root, "ls-files", "-z", "--", *batch).split(b"\0") if p)
    return sorted(found)


def tree(sc, root, paths, counts):
    for path_bytes in tracked_paths(root, paths):
        p = os.fsdecode(path_bytes)
        f = Path(root) / p
        if not p:
            continue
        try:
            mode = f.lstat().st_mode
        except FileNotFoundError:
            mode = 0  # tracked but removed from the worktree: its path still counts
        except OSError as e:
            print(f"client-data-scan: NOT CHECKED: {f}: {type(e).__name__}: {e}", file=sys.stderr)
            sys.exit(2)
        if stat.S_ISLNK(mode):  # its blob is the target: name and target, as --staged reads it
            try:
                target = os.readlink(f).encode("utf-8", "surrogateescape")
            except OSError as e:
                print(f"client-data-scan: NOT CHECKED: {f}: {type(e).__name__}: {e}", file=sys.stderr)
                sys.exit(2)
            yield from blob_hits(sc, p, target, counts)
        elif stat.S_ISREG(mode):
            ext = p.rsplit(".", 1)[-1].lower() if "." in p.rsplit("/", 1)[-1] else ""
            if ext in MEDIA:
                try:
                    with f.open("rb") as stream:
                        media = is_media(stream.read(64))
                except OSError as e:
                    print(f"client-data-scan: NOT CHECKED: {f}: {type(e).__name__}: {e}", file=sys.stderr)
                    sys.exit(2)
                if media:
                    yield from ((p, 0, r) for r in sc.path_hits(p))
                    counts["images/fonts/media not read"] += 1
                    continue
            try:
                blob = f.read_bytes()
            except OSError as e:
                print(f"client-data-scan: NOT CHECKED: {f}: {type(e).__name__}: {e}", file=sys.stderr)
                sys.exit(2)
            yield from blob_hits(sc, p, blob, counts)
        elif mode == 0 or stat.S_ISDIR(mode):  # deleted file or submodule: the name still counts
            yield from ((p, 0, r) for r in sc.path_hits(p))
        else:
            print(f"client-data-scan: NOT CHECKED: {f}: unsupported tracked file type", file=sys.stderr)
            sys.exit(2)


def message(sc, text, where):
    """Every line of a message, as stored: git keeps '#' lines and text after a scissors line (-m, -F, whitespace
    cleanup), so none is skipped; read whole, a name split across lines still matches."""
    yield from ((where, no, r) for no, r in sc.text(text))


def text_of(b):
    return decode(b) or b.decode("utf-8", "replace")


def log_hits(sc, root, revs, counts):
    # Bytes, NUL between commits: git re-encodes a message with an encoding header to UTF-8; one without is as stored
    # A record that does not start with a commit id (a NUL inside a crafted
    # message) is read as part of the previous message, never dropped.
    sha = ""
    for rec in git(root, "log", "-z", "--encoding=UTF-8", "--format=%H%n%B", *revs).split(b"\0"):
        m = re.match(rb"([0-9a-f]{40})\n", rec)
        if m:
            sha, rec = m.group(1).decode(), rec[41:]
        if rec.strip():
            yield from message(sc, text_of(rec), f"{sha}:<message>")
    yield from diff_hits(sc, root, ("log", "-p", "--diff-merges=first-parent", *DIFF, "--format=%x00commit %H", *revs), counts,
                         lambda c, p: git(root, "show", f"{c}:{p}"))


def tag_hits(sc, root):
    """Annotated tag messages and names (a tag object is no commit: git log never shows it)."""
    ids = git(root, "for-each-ref", "--format=%(objectname) %(objecttype)", "refs/tags").split(b"\n")
    ids = b"".join(x.split()[0] + b"\n" for x in ids if x.endswith(b" tag"))
    out, i = git(root, "cat-file", "--batch", stdin=ids) if ids else b"", 0
    while i < len(out):  # "<id> tag <size>\n<body>\n": read by size, so nothing in a body can end it early
        head, i = out[i:out.index(b"\n", i)].split(), out.index(b"\n", i) + 1
        body, i = out[i:i + int(head[2])], i + int(head[2]) + 1
        hdr, _, msg = body.partition(b"\n\n")  # not the tagger line: its address is the author's, not client data
        name = re.search(rb"^tag (.*)$", hdr, re.M)
        yield from message(sc, text_of((name.group(1) + b"\n" if name else b"") + msg), f"{head[0].decode()}:<tag>")


def nul_tokens(stream):
    buf = bytearray()
    while True:
        chunk = stream.read1(65536)
        if not chunk:
            break
        buf.extend(chunk)
        while (end := buf.find(0)) >= 0:
            yield bytes(buf[:end])
            del buf[:end + 1]
    if buf:
        yield bytes(buf)


def log_message_hits(sc, root, revs):
    p = subprocess.Popen(["git", "-C", root, "log", "-z", "--encoding=UTF-8", "--format=%H%n%B", *revs],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    sha = ""
    try:
        for rec in nul_tokens(p.stdout):
            m = re.match(rb"([0-9a-f]{40})\n", rec)
            if m:
                sha, rec = m.group(1).decode(), rec[41:]
            if rec.strip():
                yield from message(sc, text_of(rec), f"{sha}:<message>")
        if p.wait():
            raise RuntimeError("git message history failed")
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
        p.stdout.close()


def path_details(sc, path):
    stem = re.sub(r"\.\w{1,5}$", "", path).replace("_", " ")
    rules = collections.OrderedDict()
    for _, rule, meta in sc.text_details(path + "\n" + stem):
        candidates = rules.setdefault(rule, [])
        if meta:
            for candidate in meta["candidates"]:
                if candidate not in candidates:
                    candidates.append(candidate)
    return [{"rule": rule, "meta": {"candidates": candidates} if candidates else None}
            for rule, candidates in rules.items()]


def file_ext(path):
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def profile_blob(sc, blob, extensions):
    media = is_media(blob)
    parts = None
    container = container_kind(blob)
    need_office = container == "zip" or any(ext in OFFICE_EXT for ext in extensions)
    if need_office:
        parts = office_parts(blob)
    result = {"text": None, "raw": False, "media": media, "container": container,
              "office": parts,
              }
    if parts is not None:
        result["office"] = []
        for member, data in parts:
            member_text = decode(data)
            pic = member.rsplit(".", 1)[-1].lower() in MEDIA
            hits, part_kind = [], None
            if member_text is None or pic:
                raw = member_text if member_text is not None else data.decode("utf-8", "replace")
                hits = [list(hit) for hit in sc.text_details(raw, structural=False)]
                part_kind = "office-media" if pic else "binary"
            else:
                for i, cell in enumerate(CELL_END.split(member_text), 1):
                    cell = TAG.sub(_tag, cell)
                    if LOCAL_PATH.search(cell):
                        hits.append([i, "local-path", None])
                    hits.extend([list(hit) for hit in sc.text_details(cell)])
            name_hits = path_details(sc, member)
            if name_hits or hits or part_kind:
                result["office"].append({"member": member, "names": name_hits, "hits": hits, "kind": part_kind})
    need_plain = container is None and any(not (ext in MEDIA and media)
                     and not (ext in OFFICE_EXT and need_office
                              and result["office"] is not None)
                     for ext in extensions)
    if need_plain:
        text = decode(blob)
        if text is None:
            result["raw"] = [list(hit) for hit in sc.text_details(blob.decode("utf-8", "replace"), structural=False)]
        else:
            result["text"] = [list(hit) for hit in sc.text_details(text)]
    return result


_HISTORY_SCANNER = None
_HISTORY_ROOT = None


class EmptyAllow:
    @staticmethod
    def value(_):
        return False

    @staticmethod
    def email(*_):
        return False


def init_history_worker(root):
    global _HISTORY_SCANNER, _HISTORY_ROOT
    _HISTORY_SCANNER = Scanner(EmptyAllow())
    _HISTORY_ROOT = root


def raw_history_events(root, revs, events):
    args = ["git", "-C", root, "-c", "core.quotePath=false", "log", "--raw", "-z", "--no-abbrev",
            "--no-renames", "--diff-merges=first-parent", "--no-color", "--no-ext-diff", "--no-textconv",
            "--format=%x00commit %H", *revs]
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    commit, commits, paths, pending, batch = "", 0, 0, collections.deque(), []

    def flush():
        if batch:
            events.executemany("INSERT OR IGNORE INTO occurrences VALUES (?, ?, ?)", batch)
            batch.clear()

    try:
        for token in nul_tokens(p.stdout):
            if pending:
                oid = pending.popleft()
                if oid:
                    batch.append((commit, oid, token))
                    paths += 1
                    if len(batch) >= 1000:
                        flush()
                continue
            if token.startswith(b"commit "):
                commit = token.split()[1].decode()
                commits += 1
                if commits % 1000 == 0:
                    print(f"client-data-scan: history metadata: {commits} commits, {paths} changed paths",
                          file=sys.stderr, flush=True)
                continue
            for line in token.splitlines():
                if not line.startswith(b":"):
                    continue
                fields = line.split()
                if len(fields) < 5 or not re.fullmatch(rb"[0-9a-f]{40}", fields[3]):
                    raise ValueError("invalid raw history record")
                pending.append(fields[3].decode() if fields[3] != b"0" * 40 else "")
            if not pending and token.strip():
                raise ValueError("unexpected raw history record")
        if pending:
            raise ValueError("incomplete raw history record")
        flush()
        if p.wait():
            raise RuntimeError("git blob history failed")
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
        p.stdout.close()
    return commits, paths


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            raise RuntimeError("truncated git blob stream")
        data.extend(chunk)
    return bytes(data)


def skip_exact(stream, size):
    while size:
        chunk = stream.read(min(size, 1 << 20))
        if not chunk:
            raise RuntimeError("truncated git blob stream")
        size -= len(chunk)


def scan_blob_record(proc, scanner, oid, extensions):
    proc.stdin.write(oid.encode() + b"\n")
    proc.stdin.flush()
    header = proc.stdout.readline().split()
    if len(header) != 3 or header[0] != oid.encode() or header[1] != b"blob":
        raise RuntimeError("git cat-file returned an invalid blob header")
    size = int(header[2])
    media_only = bool(extensions) and all(ext in MEDIA for ext in extensions)
    if media_only:
        head = read_exact(proc.stdout, min(size, 64))
        if is_media(head):
            result = {"text": None, "raw": None, "media": True, "office": None,
                       }
            skip_exact(proc.stdout, size - len(head))
        else:
            blob = head + read_exact(proc.stdout, size - len(head))
            result = profile_blob(scanner, blob, extensions)
    else:
        result = profile_blob(scanner, read_exact(proc.stdout, size), extensions)
    if proc.stdout.read(1) != b"\n":
        raise RuntimeError("git cat-file returned an invalid blob terminator")
    if proc.poll() is not None:
        raise RuntimeError("git cat-file exited during a blob batch")
    return result


def scan_blob_chunk(records):
    proc = subprocess.Popen(["git", "-C", _HISTORY_ROOT, "cat-file", "--batch"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        results = [(oid, scan_blob_record(proc, _HISTORY_SCANNER, oid, extensions))
                   for oid, extensions, _ in records]
        proc.stdin.close()
        if proc.wait():
            raise RuntimeError("git cat-file batch failed")
        return results
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()


def scan_blob_profiles(sc, root, events, counts):
    extensions = collections.defaultdict(set)
    for oid, path in events.execute("SELECT DISTINCT blob_id, path FROM occurrences ORDER BY blob_id, path"):
        extensions[oid].add(file_ext(os.fsdecode(path)))
    object_ids = sorted(extensions)
    if object_ids:
        kinds = git(root, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                    stdin="\n".join(object_ids).encode() + b"\n").splitlines()
        if len(kinds) != len(object_ids):
            raise RuntimeError("git cat-file returned an incomplete blob inventory")
        records = []
        for oid, row in zip(object_ids, kinds):
            fields = row.split()
            if len(fields) == 3 and fields[0] == oid.encode() and fields[1] == b"blob":
                records.append((oid, sorted(extensions[oid]), int(fields[2])))
    else:
        records = []

    blob_ids = [record[0] for record in records]
    events.execute("CREATE TABLE valid_blobs (blob_id TEXT PRIMARY KEY)")
    events.executemany("INSERT INTO valid_blobs VALUES (?)", ((oid,) for oid in blob_ids))
    events.execute("DELETE FROM occurrences WHERE blob_id NOT IN (SELECT blob_id FROM valid_blobs)")
    events.commit()
    counts["history blobs"] = len(records)
    print(f"client-data-scan: history blobs: 0/{len(records)} scanned", file=sys.stderr, flush=True)

    def chunks():
        batch, size = [], 0
        for record in records:
            if batch and (len(batch) >= 128 or size + record[2] > 64 * 1024 * 1024):
                yield batch
                batch, size = [], 0
            batch.append(record)
            size += record[2]
            if size >= 64 * 1024 * 1024:
                yield batch
                batch, size = [], 0
        if batch:
            yield batch

    done = 0

    def report():
        print(f"client-data-scan: history blobs: {done}/{len(records)} scanned",
              file=sys.stderr, flush=True)

    if len(records) > 4:
        workers = min(8, os.cpu_count() or 1)
        local_batches = iter(chunks())
        pending = collections.deque()
        exhausted = False
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers, initializer=init_history_worker,
                                                     initargs=(root,)) as pool:
            while pending or not exhausted:
                while len(pending) < workers * 2 and not exhausted:
                    batch = next(local_batches, None)
                    if batch is None:
                        exhausted = True
                        break
                    pending.append((pool.submit(scan_blob_chunk, batch), len(batch)))
                if not pending:
                    break
                future, expected = pending.popleft()
                results = future.result()
                if len(results) != expected:
                    raise RuntimeError("history blob worker returned an incomplete batch")
                done += len(results)
                if done % 1000 < len(results) or done == len(records):
                    report()
                yield from results
    else:
        scanner = Scanner(EmptyAllow())
        proc = subprocess.Popen(["git", "-C", root, "cat-file", "--batch"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for oid, exts, _ in records:
                result = scan_blob_record(proc, scanner, oid, exts)
                done += 1
                if done % 100 == 0 or done == len(records):
                    report()
                yield oid, result
            proc.stdin.close()
            if proc.wait():
                raise RuntimeError("git cat-file batch failed")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            proc.stdout.close()
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()


def blob_profile_hits(sc, path, profile, counts):
    yield from ((path, 0, rule, None) for rule in sc.path_hits(path))
    ext = path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
    if ext in MEDIA and profile["media"]:
        counts["images/fonts/media not read"] += 1
        return
    if profile["office"] is not None:
        for part in profile["office"]:
            where = f"{path}\0{part['member']}"
            for hit in part["names"]:
                yield where, 0, hit["rule"], hit["meta"]
            for no, rule, meta in part["hits"]:
                yield where, no, rule, meta
            if part["kind"]:
                if sc.allow.path(path) or sc.allow.path(path, sc.allow.binaries):
                    counts["binaries allow-listed"] += 1
                else:
                    yield where, 0, part["kind"], None
        return
    if profile["container"] is not None:
        if sc.allow.path(path) or sc.allow.path(path, sc.allow.binaries):
            counts["binaries allow-listed"] += 1
        else:
            yield path, 0, "binary", None
        return
    if profile["text"] is not None:
        for no, rule, meta in profile["text"]:
            yield path, no, rule, meta
        return
    for no, rule, meta in profile["raw"]:
        yield path, no, rule, meta
    if sc.allow.path(path) or sc.allow.path(path, sc.allow.binaries):
        counts["binaries allow-listed"] += 1
    else:
        yield path, 0, "binary", None


def history_blob_hits(sc, root, revs, counts):
    groups = revs if revs and isinstance(revs[0], list) else [revs]
    for group in groups:
        yield from log_message_hits(sc, root, group)
    with tempfile.TemporaryDirectory(prefix="client-data-history-") as temp:
        events = sqlite3.connect(Path(temp) / "events.sqlite3")
        try:
            events.execute("PRAGMA journal_mode=OFF")
            events.execute("CREATE TABLE occurrences (commit_id TEXT, blob_id TEXT, path BLOB)")
            events.execute("CREATE UNIQUE INDEX occurrences_unique ON occurrences(commit_id, blob_id, path)")
            events.execute("CREATE INDEX occurrences_by_blob ON occurrences(blob_id)")
            commits, paths = 0, 0
            for group in groups:
                c, p = raw_history_events(root, group, events)
                commits += c
                paths += p
            events.commit()
            counts["history commits"] = commits
            counts["history paths"] = paths
            profiles = iter(scan_blob_profiles(sc, root, events, counts))
            first_profile = next(profiles, None)
            total = events.execute("SELECT COUNT(*) FROM occurrences").fetchone()[0]
            rows = iter(events.execute(
                "SELECT blob_id, commit_id, path FROM occurrences ORDER BY blob_id, commit_id, path"))
            row = next(rows, None)
            print(f"client-data-scan: history paths: 0/{total}", file=sys.stderr, flush=True)
            done = 0
            profile_stream = itertools.chain((first_profile,), profiles) if first_profile is not None else profiles
            for oid, profile in profile_stream:
                if row is not None and row[0] < oid:
                    raise RuntimeError("history paths are not ordered by blob id")
                while row is not None and row[0] == oid:
                    _, commit, path_bytes = row
                    path = os.fsdecode(path_bytes)
                    yield from ((f"{commit}:{where}", no, rule, meta)
                                for where, no, rule, meta in blob_profile_hits(sc, path, profile, counts))
                    done += 1
                    if done % 100000 == 0:
                        print(f"client-data-scan: history paths: {done}/{total}", file=sys.stderr, flush=True)
                    row = next(rows, None)
            if row is not None:
                raise RuntimeError("history paths did not match scanned blobs")
            if done != total:
                print(f"client-data-scan: history paths: {done}/{total}", file=sys.stderr, flush=True)
        finally:
            events.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true")
    mode.add_argument("--message")
    mode.add_argument("--tree", nargs="*")
    mode.add_argument("--range", nargs="+")
    mode.add_argument("--branch", action="store_true")
    mode.add_argument("--history", nargs="*")
    a, extra = ap.parse_known_args(argv)
    if extra and a.range:  # git revision options pass through: --range A --not --remotes
        a.range += extra
    elif extra and a.history is not None:
        a.history += extra
    elif extra:
        ap.error(f"unrecognized arguments: {' '.join(extra)}")
    root = a.root or git(".", "rev-parse", "--show-toplevel").decode().strip()
    allow = Allow(root, "index" if a.staged or a.message else "worktree")
    sc, counts = Scanner(allow), collections.Counter()
    if a.staged:
        hits = staged(sc, root, counts)
    elif a.message:  # the bytes git stores (-F does not re-encode): read as i18n.commitEncoding and as UTF-8/UTF-16/CP949
        b, enc = Path(a.message).read_bytes(), git(root, "config", "i18n.commitEncoding", check=False).decode().strip()
        texts = [decode(b) or b.decode("utf-8", "replace")]
        try:
            texts += [b.decode(enc)] if enc and b.decode(enc) != texts[0] else []
        except (LookupError, UnicodeDecodeError):
            pass
        hits = message(sc, "\n".join(texts), "<message>")  # line numbers count the first reading
    elif a.tree is not None:
        hits = tree(sc, root, a.tree, counts)
    else:
        if a.branch:  # git log HEAD --not dev --remotes: what this checkout adds over the trunk
            a.range = ["HEAD", "--not", *(["dev"] if git(root, "rev-parse", "-q", "--verify", "refs/heads/dev", check=False)
                                          else []), "--remotes"]
        # A bare --history reads HEAD after the repo's clean point, so a commit already pushed (and its file since
        # deleted) cannot hide from a check. ponytail: the range grows until the owner advances 'clean'.
        if a.history == [] and git(root, "rev-parse", "--is-shallow-repository").strip() == b"true":
            print("client-data-scan: NOT CHECKED: a shallow clone hides history (fetch with --unshallow or "
                  "fetch-depth: 0)", file=sys.stderr)
            return 2
        if a.range:
            hits = log_hits(sc, root, a.range, counts)
        elif a.history:
            hits = history_blob_hits(sc, root, a.history, counts)
            if {"--all", "--tags"} & set(a.history):
                hits = itertools.chain(hits, tag_hits(sc, root))
        else:  # HEAD after the clean point, and every remote ref's commits since its date (a pushed branch HEAD lacks)
            for c in allow.clean:  # a clean point hides trunk history only (landing read it); an unknown sha: exit 2
                if not git(root, "for-each-ref", "--contains", c, "refs/heads/dev", "refs/remotes/*/dev").strip():
                    print(f"client-data-scan: NOT CHECKED: clean {c} "
                          "is on no dev (local or remote): a clean "
                          "point may only hide trunk history", file=sys.stderr)
                    return 2
            since = min((int(git(root, "log", "-1", "--format=%ct", c)) for c in allow.clean), default=None)
            rev_groups = [
                ["HEAD", "--not", *allow.clean],
                ["--remotes", "--tags", *([f"--max-age={since}"] if since else []), "--not", "HEAD",
                 *allow.clean],
            ]
            hits = itertools.chain(
                history_blob_hits(sc, root, rev_groups, counts),
                tag_hits(sc, root))
    n, files = 0, set()
    per = collections.defaultdict(lambda: collections.defaultdict(set))
    try:
        for finding in hits:
            where, no, rule = finding[:3]
            meta = finding[3] if len(finding) == 4 else None
            if allow.hit_allowed(meta):
                continue
            sha, path = where.split(":", 1) if a.range or a.history is not None else ("", where)
            path, bang, member = path.partition("\0")
            if allow.path(path) or allow.path(path, allow.binaries):
                counts["allowed hits"] += 1
                continue
            named_path = path + ("!" + member if bang else "")
            n += 1
            if a.history is not None:
                per[named_path][rule].add(sha)
            else:
                shown = (sha + ":" if sha else "") + sc.show(named_path)
                print(f"client-data: {rule} {shown}:{no}")
                files.add((sha, named_path) if sha else named_path)
    except Exception as e:
        if a.history is None:
            raise
        print(f"client-data-scan: NOT CHECKED: history scan failed ({type(e).__name__})", file=sys.stderr)
        return 2
    for p in sorted(per):
        files.add(p)
        print(f"client-data: {sc.show(p)}: " + ", ".join(
            f"{r} in {len(s)} commits" for r, s in sorted(per[p].items())))
    if per:
        counts["commits with hits"] = len(set().union(*(s for d in per.values() for s in d.values())))
    listed = "structural only"
    if a.history is not None and not a.history:
        listed += (f"; history: HEAD after {', '.join(allow.clean) or 'the root'}, remote refs "
                   f"{'since its date' if allow.clean else 'from the root'}")
    listed += (f"; allow-list: {len(allow.paths)} paths, {len(allow.binaries)} binaries, "
               f"{len(allow.values)} values, {len(allow.emails)} e-mail")
    if allow.ignored_terms:
        listed += f"; ignored obsolete term entries: {allow.ignored_terms} (no effect)"
    extra = "".join(f"; {k}: {v}" for k, v in sorted(counts.items()))
    print(f"client-data-scan: {n} hits in {len(files)} files; {listed}{extra}", file=sys.stderr)
    if n:
        print("client-data-scan: replace client data with synthetic values (example.com, 000-00-00000 range); "
              "never commit it", file=sys.stderr)
    return 1 if n else 0


if __name__ == "__main__":
    sys.exit(main())
