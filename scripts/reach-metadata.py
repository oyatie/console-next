#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Read reach's manifest facts without installing or invoking a Rust toolchain."""
import json
from pathlib import Path
import sys
import tomllib


def read(path):
    return tomllib.loads(path.read_text())


root = Path(sys.argv[1]).resolve()
workspace = read(root / "Cargo.toml")["workspace"]
excluded = {path.resolve() for pattern in workspace.get("exclude", []) for path in root.glob(pattern)}
members = {path.resolve() for pattern in workspace["members"] for path in root.glob(pattern)} - excluded
packages = []
pending = list(members)
while pending:
    member = pending.pop()
    manifest = read(member / "Cargo.toml")
    dependencies = []
    tables = [manifest, *manifest.get("target", {}).values()]
    for table in tables:
        for kind in ("dependencies", "dev-dependencies", "build-dependencies"):
            for alias, value in table.get(kind, {}).items():
                options = value if isinstance(value, dict) else {}
                origin = root if options.get("workspace") else member
                if options.get("workspace"):
                    inherited = workspace["dependencies"][alias]
                    options = {**(inherited if isinstance(inherited, dict) else {}), **options}
                if "path" in options:
                    dependency = (origin / options["path"]).resolve()
                    if dependency.is_relative_to(root) and dependency not in members | excluded:
                        members.add(dependency)
                        pending.append(dependency)
                if kind == "dependencies":
                    name = options.get("package", alias)
                    dependencies.append({"name": name, "rename": alias if alias != name else None, "optional": options.get("optional", False)})
    packages.append({"name": manifest["package"]["name"], "manifest_path": str(member / "Cargo.toml"),
                     "features": manifest.get("features", {}), "dependencies": dependencies})
print(json.dumps({"packages": sorted(packages, key=lambda package: package["name"])}))
