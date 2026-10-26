#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
set -euo pipefail
image="$1"
container="$(docker run --detach --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges --publish 127.0.0.1::8080 "${image}")"
trap 'docker logs "${container}"; docker rm --force "${container}" >/dev/null' EXIT
port="$(docker port "${container}" 8080/tcp | cut -d: -f2)"
curl --fail --silent --show-error --retry 30 --retry-all-errors --retry-delay 1 "http://127.0.0.1:${port}/healthz" | jq -e '.status == "ok" and .role == "api"'
curl --fail --silent --show-error "http://127.0.0.1:${port}/readyz" | jq -e '.status == "ready"'
curl --fail --silent --show-error "http://127.0.0.1:${port}/" | grep -i '<!doctype html>' >/dev/null
# An unknown role must retain the executable's EX_USAGE contract.
set +e
docker run --rm --env CONSOLE_APP_ROLE=invalid "${image}"
code=$?
set -e
test "${code}" -eq 64
