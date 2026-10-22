#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Record the public browser distribution immediately after the locked installer."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
files = {}
for file in root.rglob("*"):
    if file.is_symlink():
        raise ValueError("browser distribution contains a symlink")
    if file.is_file():
        with file.open("rb") as stream:
            files[str(file.relative_to(root))] = hashlib.file_digest(stream, "sha256").hexdigest()
if not files:
    raise ValueError("browser installation is empty")
Path(sys.argv[2]).write_text(json.dumps({"root": str(root), "files": files}))
