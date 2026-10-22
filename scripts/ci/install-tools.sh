#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tool_dir="${RUNNER_TEMP:?}/console-tools"
mkdir -p "$tool_dir/bin"
for tool in "$@"; do
  url="$(jq -er --arg tool "$tool" '.[$tool].url' "$root/scripts/ci/versions.json")"
  checksum="$(jq -er --arg tool "$tool" '.[$tool].sha256' "$root/scripts/ci/versions.json")"
  binary="$(jq -er --arg tool "$tool" '.[$tool].binary' "$root/scripts/ci/versions.json")"
  archive="$tool_dir/$tool.tar.gz"
  curl --fail --silent --show-error --location "$url" -o "$archive"
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
  mkdir -p "$tool_dir/$tool"
  tar -xzf "$archive" -C "$tool_dir/$tool"
  found="$(find "$tool_dir/$tool" -type f -name "$binary")"
  [[ -f "$found" ]] || { echo "missing tool binary: $tool" >&2; exit 1; }
  install -m 755 "$found" "$tool_dir/bin/$binary"
done
echo "$tool_dir/bin" >>"${GITHUB_PATH:?}"
