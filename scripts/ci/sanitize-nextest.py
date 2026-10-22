#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Remove unused upstream author contacts before sharing Cargo metadata."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile


def metadata(data):
    value = json.loads(data)
    for package in value["packages"]:
        package["authors"] = []
    return json.dumps(value).encode()


archive, manifest = map(Path, sys.argv[1:])
with tempfile.TemporaryFile() as expanded:
    subprocess.run(["zstd", "-dq", "-c", str(archive)], stdout=expanded, check=True)
    expanded.seek(0)
    with tempfile.TemporaryFile() as rewritten:
        with tarfile.open(fileobj=expanded, mode="r|") as source, tarfile.open(fileobj=rewritten, mode="w|") as output:
            found = False
            for entry in source:
                stream = source.extractfile(entry) if entry.isfile() else None
                if entry.name == "target/nextest/cargo-metadata.json":
                    data = metadata(stream.read())
                    entry.size = len(data)
                    stream = io.BytesIO(data)
                    found = True
                output.addfile(entry, stream)
            if not found:
                raise ValueError("nextest Cargo metadata missing")
        rewritten.seek(0)
        with tempfile.NamedTemporaryFile(dir=archive.parent, delete=False) as compressed:
            temporary = Path(compressed.name)
            try:
                subprocess.run(["zstd", "-q", "-c"], stdin=rewritten, stdout=compressed, check=True)
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
manifest.write_bytes(metadata(manifest.read_bytes()))
