#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Scan upload contents with the curated structural rules; never print payloads."""
import base64
import codecs
import datetime
from email.header import decode_header, make_header
import gzip
import hashlib
import importlib.util
from http.client import parse_headers
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("client_data", ROOT / "scripts/client-data-scan.py")
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)
allow = rules.Allow(ROOT)
scanner = rules.Scanner(allow)
terms = []
browser_manifest = None
class Refusal(Exception):
    pass


counts = {"files": 0, "members": 0, "publicDependencies": 0}


def text_hits(text):
    if any(term in text.casefold() for term in terms):
        raise Refusal("private client term")
    hit = next(scanner.text(text), None)
    if hit:
        raise Refusal("structural " + hit[1])
    # The fixture gate also recognizes the leading-zero form lost by Excel.
    for match in re.finditer(r"(?<![\w.])([1-9][0-9]{10,11})(?:\.0)?(?![\w])", text):
        digits = match[1].zfill(13)
        if digits[6] not in "3478":
            continue
        try:
            datetime.date(2000 + int(digits[:2]), int(digits[2:4]), int(digits[4:6]))
        except ValueError:
            continue
        if rules.rrn_ok(digits):
            raise Refusal("checksum-valid identifier")


def public_dependency(file):
    """Public package tarballs are proven by the lockfile, not by an opaque-path exemption."""
    if browser_manifest:
        root = Path(browser_manifest["root"])
        if file.resolve().is_relative_to(root):
            with file.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if browser_manifest["files"].get(str(file.resolve().relative_to(root))) != actual:
                raise Refusal("public browser distribution changed during tests")
            return True
    name = str(file.resolve())
    if "/.cargo/registry/cache/" in name and file.suffix == ".crate":
        lock = tomllib.loads((ROOT / "backend/Cargo.lock").read_text())
        with file.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if not any(p.get("checksum") == digest and p.get("source", "").startswith("registry+")
                   and file.name == f"{p['name']}-{p['version']}.crate" for p in lock["package"]):
            raise Refusal("Cargo cache checksum mismatch")
        return True
    if "/_cacache/content-v2/sha512/" in name:
        lock = json.loads((ROOT / "package-lock.json").read_text())
        with file.open("rb") as stream:
            digest = "sha512-" + base64.b64encode(hashlib.file_digest(stream, "sha512").digest()).decode()
        if not any(p.get("integrity") == digest for p in lock["packages"].values()):
            raise Refusal("npm cache checksum mismatch")
        return True
    return False


def scan_multipart(stream, name, boundary, depth, office):
    delimiter = b"--" + boundary
    if stream.readline(len(delimiter) + 3).rstrip(b"\r\n") != delimiter:
        raise Refusal("invalid multipart boundary")
    final = False
    while not final:
        start = stream.tell()
        # The standard HTTP parser bounds both header length and header count.
        headers = parse_headers(stream)
        end = stream.tell()
        stream.seek(start)
        text_hits(stream.read(end - start).decode("utf-8", "replace"))
        if headers.defects or not headers.get("Content-Disposition"):
            raise Refusal("invalid multipart headers")
        if headers.get("Content-Transfer-Encoding", "binary").lower() not in ("binary", "7bit", "8bit"):
            raise Refusal("unsupported multipart transfer encoding")
        for value in headers.values():
            text_hits(str(make_header(decode_header(value))))
        filename = headers.get_filename() or name + ".part"
        text_hits(filename)
        with tempfile.TemporaryFile() as body:
            at_line_start = True
            while line := stream.readline(1024 * 1024):
                marker = line.rstrip(b"\r\n")
                if at_line_start and marker in (delimiter, delimiter + b"--"):
                    size = body.tell()
                    if size:
                        body.seek(max(0, size - 2))
                        if body.read() != b"\r\n":
                            raise Refusal("invalid multipart framing")
                        body.truncate(size - 2)
                    body.seek(0)
                    counts["members"] += 1
                    scan(body, filename, depth + 1, office)
                    final = marker == delimiter + b"--"
                    break
                body.write(line)
                at_line_start = line.endswith(b"\n")
            else:
                raise Refusal("incomplete multipart payload")
    with tempfile.TemporaryFile() as tail:
        while chunk := stream.read(1024 * 1024):
            tail.write(chunk)
        if tail.tell():
            tail.seek(0)
            scan(tail, name + ".epilogue", depth + 1, office)


def scan(stream, name, depth=0, office=False):
    if depth > 8:
        raise Refusal("archive nesting exceeds limit")
    text_hits(name)
    head = stream.read(512)
    stream.seek(0)
    if head.startswith(b"\x28\xb5\x2f\xfd"):
        # No archive path is ever extracted onto the runner filesystem.
        with tempfile.TemporaryFile() as decoded:
            os.lseek(stream.fileno(), 0, os.SEEK_SET)
            proc = subprocess.run(["zstd", "-dq", "-c"], stdin=stream, stdout=decoded, stderr=subprocess.DEVNULL)
            if proc.returncode:
                raise Refusal("invalid zstd payload")
            decoded.seek(0)
            scan(decoded, name + ".decoded", depth + 1, office)
        return
    if head.startswith(b"\x1f\x8b"):
        with gzip.GzipFile(fileobj=stream) as zipped, tempfile.TemporaryFile() as decoded:
            while chunk := zipped.read(1024 * 1024):
                decoded.write(chunk)
            decoded.seek(0)
            scan(decoded, name + ".decoded", depth + 1, office)
        return
    if head.startswith(rules.ZIP_MAGIC):
        with zipfile.ZipFile(stream) as archive:
            office = office or "[Content_Types].xml" in archive.namelist()
            for entry in archive.infolist():
                text_hits(entry.filename)
                if entry.is_dir():
                    continue
                counts["members"] += 1
                # Zip members are bounded by their on-disk artifact, not by trust in a filename.
                with archive.open(entry) as member, tempfile.TemporaryFile() as decoded:
                    while chunk := member.read(1024 * 1024):
                        decoded.write(chunk)
                    decoded.seek(0)
                    scan(decoded, entry.filename, depth + 1, office)
        return
    if head[257:262] == b"ustar":
        with tarfile.open(fileobj=stream, mode="r|*") as archive:
            for entry in archive:
                text_hits(entry.name)
                if entry.isdir():
                    continue
                if not entry.isfile():
                    raise Refusal("non-regular archive member")
                counts["members"] += 1
                with archive.extractfile(entry) as member, tempfile.TemporaryFile() as decoded:
                    while chunk := member.read(1024 * 1024):
                        decoded.write(chunk)
                    decoded.seek(0)
                    scan(decoded, entry.name, depth + 1, office)
        return
    # The structural scanner deliberately does not OCR raster media; it checks names.
    if rules.is_media(head):
        return
    first = head.partition(b"\r\n")[0]
    if first.startswith(b"--") and b"content-disposition:" in head.lower():
        boundary = first[2:]
        if not re.fullmatch(rb"[-0-9A-Za-z'()+_,./:=? ]{1,70}", boundary):
            raise Refusal("invalid multipart boundary")
        scan_multipart(stream, name, boundary, depth, office)
        return
    encoding = "utf-16" if head.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8"
    decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
    binary = b"\0" in head and encoding != "utf-16"
    if binary:
        raise Refusal("unsupported binary payload")
    overlap = ""
    while chunk := stream.read(1024 * 1024):
        text = overlap + decoder.decode(chunk).replace("\0", "\n")
        if name.endswith((".xml", ".rels")):
            text = rules.TAG.sub(rules._tag, text)
            if office and rules.LOCAL_PATH.search(text):
                raise Refusal("local office path")
        text_hits(text)
        overlap = text[-4096:]
    text_hits(overlap + decoder.decode(b"", final=True))


def walk(file):
    text_hits(file.name)
    if file.is_symlink():
        raise Refusal("symlink upload")
    if file.is_dir():
        for child in file.iterdir():
            walk(child)
    elif file.is_file():
        counts["files"] += 1
        if public_dependency(file):
            counts["publicDependencies"] += 1
            return
        with file.open("rb") as stream:
            scan(stream, file.name)
    else:
        raise Refusal("non-regular upload")


try:
    browser_file = os.environ.get("CONSOLE_PUBLIC_BROWSER_MANIFEST_FILE")
    if browser_file:
        browser_manifest = json.loads(Path(browser_file).read_text())
    private_file = os.environ.get("CONSOLE_CLIENT_DATA_TERMS_FILE")
    if private_file:
        terms = [line.strip().casefold() for line in Path(private_file).read_text().splitlines() if line.strip()]
    if sys.argv[1:] == ["--terms-tree"]:
        source_root = Path(os.environ.get("CI_SCAN_SOURCE_ROOT", ROOT))
        if terms:
            for name in rules.git(str(source_root), "ls-files", "-z").split(b"\0"):
                if name:
                    file = source_root / os.fsdecode(name)
                    data = file.read_bytes() if file.is_file() and not file.is_symlink() else b""
                    text = str(file.relative_to(source_root)) + "\n" + (rules.decode(data) or data.decode("utf-8", "replace"))
                    if any(term in text.casefold() for term in terms):
                        raise Refusal("private client term")
        print("privacy: trusted term tree check passed")
        sys.exit(0)
    for source in sys.argv[1:]:
        file = Path(source)
        if file.exists() or file.is_symlink():
            walk(file)
    print("privacy: structural and checksum scans passed; " + json.dumps(counts, sort_keys=True))
except Exception as error:
    # Exception text, file/member names and scanner findings can themselves contain personal data.
    print("privacy: payload scan refused (" + (str(error) if isinstance(error, Refusal) else type(error).__name__) + "); output withheld", file=sys.stderr)
    sys.exit(1)
