#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Measure produced bytes and stream archive inventories before any transfer."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import sys

ROOT = Path(__file__).resolve().parents[2]


def size(paths):
    seen = set()
    total = 0
    for path in paths:
        files = path.rglob("*") if path.is_dir() else [path]
        for file in files:
            if file.is_file() and not file.is_symlink():
                stat = file.stat()
                inode = (stat.st_dev, stat.st_ino)
                if inode not in seen:
                    seen.add(inode)
                    total += stat.st_size
    return total


def enforce(build, extraction, free, config):
    if max(build, extraction) >= config["runnerDiskBudgetBytes"] * 0.8:
        print("::warning::CI disk usage reached 80% of the provisional budget; compare hosted receipts.")
    if max(build, extraction) > config["runnerDiskBudgetBytes"] or free < config["runnerDiskMarginBytes"]:
        raise ValueError("CI disk budget exceeded")


if __name__ == "__main__":
    config = json.loads((ROOT / "scripts/ci/config.json").read_text())
    output = ROOT / ".cache/ci/build"
    archives = []
    test_job = sys.argv[1:] == ["--test"]
    for file in ([ROOT / ".cache/ci/workspace.tar.zst"] if test_job else output.rglob("*.tar.zst")):
        proc = subprocess.Popen(["zstd", "-dq", "-c", str(file)], stdout=subprocess.PIPE)
        with tarfile.open(fileobj=proc.stdout, mode="r|") as archive:
            expanded = sum(entry.size for entry in archive)
        if proc.wait():
            raise ValueError("unreadable test archive")
        archives.append({"compressed": file.stat().st_size, "expanded": expanded})
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).split(b"\0")
    checkout = size([ROOT / os.fsdecode(file) for file in tracked if file])
    if test_job:
        expanded = max(a["expanded"] for a in archives)
        extraction = max(a["compressed"] + a["expanded"] for a in archives) + checkout
        free = shutil.disk_usage(ROOT / ".cache/ci").free
        enforce(0, extraction, free - expanded, config)
        print("CI extraction disk bytes: " + json.dumps({"testJobBytes": extraction, "freeBytes": free}))
        sys.exit(0)
    # The hosted registry is lock-scoped. Count only those source packages on a shared local cache.
    metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--format-version", "1", "--locked"], cwd=ROOT / "backend"))
    sources = size([Path(pkg["manifest_path"]).parent for pkg in metadata["packages"] if pkg.get("source")])
    compiler_cache = max(size([ROOT / ".cache/sccache"]), config["sccacheBytes"])
    build = size([Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "backend/target")), output]) + checkout + sources + compiler_cache
    extraction = max((a["compressed"] + a["expanded"] for a in archives), default=0) + checkout
    free = shutil.disk_usage(output).free
    report = {"buildBytes": build, "testJobBytes": extraction, "freeBytes": free, "sourceBytes": sources, "checkoutBytes": checkout, "compilerCacheReserve": compiler_cache, "archives": archives}
    (ROOT / ".cache/ci/disk.json").write_text(json.dumps(report))
    enforce(build, extraction, free, config)
    print("CI disk bytes: " + json.dumps(report))
